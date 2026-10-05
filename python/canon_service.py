"""Canon EOS USB Live View and still capture for the photo booth.

This process owns the Canon SDK session, supplies EVF JPEG frames, controls
autofocus and shutter, downloads the full-resolution JPEG, then crops it to
match the on-screen viewfinder.
"""

from __future__ import annotations

import base64
import json
import math
import os
import queue
import struct
import sys
import threading
import time
import traceback
from ctypes import (
    WINFUNCTYPE,
    byref,
    c_char,
    c_int,
    c_int32,
    c_uint,
    c_uint32,
    c_uint64,
    c_void_p,
    create_string_buffer,
)
from ctypes import Structure, WinDLL, cast

EDS_ERR_OK = 0x00000000
EDS_ERR_INTERNAL_ERROR = 0x00000002
EDS_ERR_DEVICE_BUSY = 0x00000081
EDS_ERR_OBJECT_NOTREADY = 0x0000A102
PROP_PRODUCT_NAME = 0x00000002
PROP_EVF_OUTPUT_DEVICE = 0x00000500
EVF_OUTPUT_TFT = 1
EVF_OUTPUT_PC = 2
PROP_SAVE_TO = 0x0000000B
CMD_EXTEND_SHUTDOWN = 0x00000001
CMD_PRESS_SHUTTER = 0x00000004
SHUTTER_OFF = 0x00000000
SHUTTER_HALFWAY = 0x00000001
SHUTTER_COMPLETELY = 0x00000003
SHUTTER_COMPLETELY_NON_AF = 0x00010003
SAVE_TO_HOST = 2
OBJECT_EVENT_ALL = 0x00000200
DIR_ITEM_REQUEST_TRANSFER = 0x00000208
DIR_ITEM_REQUEST_TRANSFER_DT = 0x00000209
STATE_EVENT_ALL = 0x00000300
STATE_WILL_SOON_SHUT_DOWN = 0x00000303
ACCESS_READ_WRITE = 2
FILE_CREATE_ALWAYS = 1
FILE_NAME_MAX = 256

download_queue: queue.Queue = queue.Queue()
extend_shutdown = threading.Event()
callback_refs = []


class DirectoryItemInfo(Structure):
    _fields_ = [
        ("size", c_uint64),
        ("isFolder", c_int),
        ("groupID", c_uint32),
        ("option", c_uint32),
        ("szFileName", c_char * FILE_NAME_MAX),
        ("format", c_uint32),
        ("dateTime", c_uint32),
    ]


class Capacity(Structure):
    _fields_ = [
        ("numberOfFreeClusters", c_int32),
        ("bytesPerSector", c_int32),
        ("reset", c_int),
    ]


def sdk_dir() -> str:
    root = os.environ.get("CANON_EDSDK_DIR", "").strip()
    if root and os.path.isdir(root):
        return root
    here = os.path.dirname(os.path.abspath(__file__))
    project = os.path.dirname(here)
    bits = struct.calcsize("P") * 8
    folder = "EDSDK_64" if bits == 64 else "EDSDK"
    candidate = os.path.join(project, "EDSDK_v13.20.21_Windows", folder, "Dll")
    if os.path.isdir(candidate):
        return candidate
    raise FileNotFoundError("Canon EDSDK folder was not found.")


def load_sdk():
    folder = sdk_dir()
    dll_path = os.path.join(folder, "EDSDK.dll")
    if not os.path.isfile(dll_path):
        raise FileNotFoundError(f"EDSDK.dll is missing from {folder}")
    if hasattr(os, "add_dll_directory"):
        os.add_dll_directory(folder)
    kernel = WinDLL("kernel32", use_last_error=True)
    kernel.SetDllDirectoryW(folder)
    sdk = WinDLL(dll_path)
    sdk.EdsInitializeSDK.argtypes = []
    sdk.EdsInitializeSDK.restype = c_uint
    sdk.EdsTerminateSDK.argtypes = []
    sdk.EdsTerminateSDK.restype = c_uint
    sdk.EdsGetCameraList.argtypes = [c_void_p]
    sdk.EdsGetCameraList.restype = c_uint
    sdk.EdsGetChildCount.argtypes = [c_void_p, c_void_p]
    sdk.EdsGetChildCount.restype = c_uint
    sdk.EdsGetChildAtIndex.argtypes = [c_void_p, c_int32, c_void_p]
    sdk.EdsGetChildAtIndex.restype = c_uint
    sdk.EdsOpenSession.argtypes = [c_void_p]
    sdk.EdsOpenSession.restype = c_uint
    sdk.EdsCloseSession.argtypes = [c_void_p]
    sdk.EdsCloseSession.restype = c_uint
    sdk.EdsRelease.argtypes = [c_void_p]
    sdk.EdsRelease.restype = c_uint
    sdk.EdsRetain.argtypes = [c_void_p]
    sdk.EdsRetain.restype = c_uint
    sdk.EdsGetEvent.argtypes = []
    sdk.EdsGetEvent.restype = c_uint
    sdk.EdsSendCommand.argtypes = [c_void_p, c_uint32, c_int32]
    sdk.EdsSendCommand.restype = c_uint
    sdk.EdsGetPropertyData.argtypes = [c_void_p, c_uint32, c_int32, c_uint32, c_void_p]
    sdk.EdsGetPropertyData.restype = c_uint
    sdk.EdsSetPropertyData.argtypes = [c_void_p, c_uint32, c_int32, c_uint32, c_void_p]
    sdk.EdsSetPropertyData.restype = c_uint
    sdk.EdsSetCapacity.argtypes = [c_void_p, Capacity]
    sdk.EdsSetCapacity.restype = c_uint
    sdk.EdsGetDirectoryItemInfo.argtypes = [c_void_p, c_void_p]
    sdk.EdsGetDirectoryItemInfo.restype = c_uint
    sdk.EdsCreateFileStream.argtypes = [c_void_p, c_uint32, c_uint32, c_void_p]
    sdk.EdsCreateFileStream.restype = c_uint
    sdk.EdsCreateMemoryStream.argtypes = [c_uint64, c_void_p]
    sdk.EdsCreateMemoryStream.restype = c_uint
    sdk.EdsCreateEvfImageRef.argtypes = [c_void_p, c_void_p]
    sdk.EdsCreateEvfImageRef.restype = c_uint
    sdk.EdsDownloadEvfImage.argtypes = [c_void_p, c_void_p]
    sdk.EdsDownloadEvfImage.restype = c_uint
    sdk.EdsGetPointer.argtypes = [c_void_p, c_void_p]
    sdk.EdsGetPointer.restype = c_uint
    sdk.EdsGetLength.argtypes = [c_void_p, c_void_p]
    sdk.EdsGetLength.restype = c_uint
    sdk.EdsDownload.argtypes = [c_void_p, c_uint64, c_void_p]
    sdk.EdsDownload.restype = c_uint
    sdk.EdsDownloadComplete.argtypes = [c_void_p]
    sdk.EdsDownloadComplete.restype = c_uint
    sdk.EdsDownloadCancel.argtypes = [c_void_p]
    sdk.EdsDownloadCancel.restype = c_uint
    sdk.EdsSetObjectEventHandler.argtypes = [c_void_p, c_uint32, c_void_p, c_void_p]
    sdk.EdsSetObjectEventHandler.restype = c_uint
    sdk.EdsSetCameraStateEventHandler.argtypes = [c_void_p, c_uint32, c_void_p, c_void_p]
    sdk.EdsSetCameraStateEventHandler.restype = c_uint
    return sdk


def check(sdk, err: int, action: str) -> None:
    if err != EDS_ERR_OK:
        raise RuntimeError(f"{action} failed ({err:#010x}).")


def send_command(sdk, camera, command: int, param: int, action: str) -> None:
    for _ in range(8):
        err = sdk.EdsSendCommand(camera, command, param)
        if err == EDS_ERR_OK:
            return
        if err == EDS_ERR_DEVICE_BUSY:
            time.sleep(0.2)
            sdk.EdsGetEvent()
            continue
        raise RuntimeError(f"{action} failed ({err:#010x}).")
    raise RuntimeError(f"{action} failed because the camera stayed busy.")


def pump(sdk, camera) -> None:
    sdk.EdsGetEvent()
    if extend_shutdown.is_set() and camera:
        extend_shutdown.clear()
        try:
            sdk.EdsSendCommand(camera, CMD_EXTEND_SHUTDOWN, 0)
        except Exception:
            pass


def download_item(sdk, item, dest_path: str) -> str:
    info = DirectoryItemInfo()
    err = sdk.EdsGetDirectoryItemInfo(item, byref(info))
    if err != EDS_ERR_OK:
        sdk.EdsDownloadCancel(item)
        sdk.EdsRelease(item)
        raise RuntimeError(f"Could not read the Canon file info ({err:#010x}).")
    name = bytes(info.szFileName).split(b"\x00", 1)[0].decode("mbcs", "replace")
    suffix = os.path.splitext(name)[1].lower()
    if suffix not in {".jpg", ".jpeg"}:
        sdk.EdsDownloadCancel(item)
        sdk.EdsRelease(item)
        return ""
    stream = c_void_p()
    path_buf = create_string_buffer(dest_path.encode("mbcs", "replace"))
    err = sdk.EdsCreateFileStream(path_buf, FILE_CREATE_ALWAYS, ACCESS_READ_WRITE, byref(stream))
    if err != EDS_ERR_OK:
        sdk.EdsDownloadCancel(item)
        sdk.EdsRelease(item)
        raise RuntimeError(f"Could not create the photo file ({err:#010x}).")
    err = sdk.EdsDownload(item, c_uint64(info.size), stream)
    if err == EDS_ERR_OK:
        err = sdk.EdsDownloadComplete(item)
    else:
        sdk.EdsDownloadCancel(item)
    sdk.EdsRelease(stream)
    sdk.EdsRelease(item)
    if err != EDS_ERR_OK:
        raise RuntimeError(f"Could not download the Canon photo ({err:#010x}).")
    return dest_path


def drain(sdk, dest_dir: str) -> list[str]:
    saved = []
    while True:
        try:
            item = download_queue.get_nowait()
        except queue.Empty:
            return saved
        target = os.path.join(dest_dir, f"canon-{int(time.time() * 1000)}.jpg")
        path = download_item(sdk, item, target)
        if path:
            saved.append(path)


class Camera:
    def __init__(self, sdk):
        self.sdk = sdk
        self.camera = c_void_p()
        self.camera_list = c_void_p()
        self.model = ""
        self.ready = False
        self.initialized = False
        self.focus_prepared = False
        self.focus_attempted = False

    def connect(self) -> str:
        if self.ready:
            return self.model or "Canon EOS"
        sdk = self.sdk
        try:
            initialize_error = sdk.EdsInitializeSDK()
            if initialize_error == EDS_ERR_INTERNAL_ERROR:
                raise RuntimeError("Canon SDK could not start. Close Canon EOS Utility, confirm the Canon USB cable is connected, then try again.")
            check(sdk, initialize_error, "Start Canon SDK")
            self.initialized = True
            check(sdk, sdk.EdsGetCameraList(byref(self.camera_list)), "List Canon cameras")
            count = c_uint32()
            check(sdk, sdk.EdsGetChildCount(self.camera_list, byref(count)), "Count Canon cameras")
            if count.value < 1:
                raise RuntimeError("No Canon camera is connected. Plug in the USB cable and turn the camera on.")
            check(sdk, sdk.EdsGetChildAtIndex(self.camera_list, 0, byref(self.camera)), "Open Canon camera")
            check(sdk, sdk.EdsOpenSession(self.camera), "Open Canon session")
            self._enable_live_view()
            self._install_handlers()
            save_to = c_uint32(SAVE_TO_HOST)
            err = sdk.EdsSetPropertyData(self.camera, PROP_SAVE_TO, 0, 4, byref(save_to))
            if err != EDS_ERR_OK:
                raise RuntimeError(
                    f"Could not save photos to this computer ({err:#010x}). Set the camera USB mode to PC remote."
                )
            capacity = Capacity(0x7FFFFFFF, 0x1000, 1)
            check(sdk, sdk.EdsSetCapacity(self.camera, capacity), "Set host capacity")
            sdk.EdsSendCommand(self.camera, CMD_EXTEND_SHUTDOWN, 0)
            self.model = self._product_name()
            self.ready = True
            pump(sdk, self.camera)
            return self.model or "Canon EOS"
        except Exception:
            self.close()
            raise

    def _enable_live_view(self) -> None:
        """Send Live View to both the camera display/HDMI and this computer."""
        sdk = self.sdk
        device = c_uint32()
        check(sdk, sdk.EdsGetPropertyData(self.camera, PROP_EVF_OUTPUT_DEVICE, 0, 4, byref(device)), "Read Canon Live View output")
        device.value |= EVF_OUTPUT_TFT | EVF_OUTPUT_PC
        for _ in range(10):
            error = sdk.EdsSetPropertyData(self.camera, PROP_EVF_OUTPUT_DEVICE, 0, 4, byref(device))
            if error == EDS_ERR_OK:
                pump(sdk, self.camera)
                return
            if error != EDS_ERR_DEVICE_BUSY:
                break
            pump(sdk, self.camera)
            time.sleep(0.2)
        raise RuntimeError(f"Could not enable Canon Live View for HDMI preview ({error:#010x}).")

    def _install_handlers(self) -> None:
        sdk = self.sdk

        @WINFUNCTYPE(c_uint, c_uint, c_void_p, c_void_p)
        def on_object(event, ref, _context):
            if event in (DIR_ITEM_REQUEST_TRANSFER, DIR_ITEM_REQUEST_TRANSFER_DT) and ref:
                sdk.EdsRetain(ref)
                download_queue.put(ref)
            return 0

        @WINFUNCTYPE(c_uint, c_uint, c_uint32, c_void_p)
        def on_state(event, _data, _context):
            if event == STATE_WILL_SOON_SHUT_DOWN:
                extend_shutdown.set()
            return 0

        callback_refs[:] = [on_object, on_state]
        sdk.EdsSetObjectEventHandler(self.camera, OBJECT_EVENT_ALL, cast(on_object, c_void_p), None)
        sdk.EdsSetCameraStateEventHandler(self.camera, STATE_EVENT_ALL, cast(on_state, c_void_p), None)

    def _product_name(self) -> str:
        buf = create_string_buffer(FILE_NAME_MAX)
        err = self.sdk.EdsGetPropertyData(self.camera, PROP_PRODUCT_NAME, 0, FILE_NAME_MAX, buf)
        if err != EDS_ERR_OK:
            return ""
        return buf.value.decode("mbcs", "replace").strip()

    def close(self) -> None:
        sdk = self.sdk
        if self.camera:
            if self.focus_prepared:
                try:
                    sdk.EdsSendCommand(self.camera, CMD_PRESS_SHUTTER, SHUTTER_OFF)
                except Exception:
                    pass
            self.focus_prepared = False
            self.focus_attempted = False
            try:
                sdk.EdsCloseSession(self.camera)
            except Exception:
                pass
            sdk.EdsRelease(self.camera)
            self.camera = c_void_p()
        if self.camera_list:
            sdk.EdsRelease(self.camera_list)
            self.camera_list = c_void_p()
        if self.initialized:
            sdk.EdsTerminateSDK()
            self.initialized = False
        self.ready = False

    def prepare_capture(self) -> None:
        """Start autofocus early and hold the half-press through the countdown."""
        self.connect()
        if self.focus_prepared:
            return
        pump(self.sdk, self.camera)
        self.focus_attempted = True
        send_command(self.sdk, self.camera, CMD_PRESS_SHUTTER, SHUTTER_HALFWAY, "Autofocus")
        self.focus_prepared = True

    def release_focus(self) -> None:
        if not self.ready:
            return
        if self.focus_prepared:
            send_command(self.sdk, self.camera, CMD_PRESS_SHUTTER, SHUTTER_OFF, "Release autofocus")
        self.focus_prepared = False
        self.focus_attempted = False

    def take(self, dest_dir: str) -> str:
        self.connect()
        os.makedirs(dest_dir, exist_ok=True)
        sdk = self.sdk
        pump(sdk, self.camera)
        drain(sdk, dest_dir)
        if not self.focus_prepared and not self.focus_attempted:
            try:
                self.prepare_capture()
            except RuntimeError as error:
                sys.stderr.write(f"Half-press autofocus skipped: {error}\n")
            deadline = time.time() + 0.8
            while time.time() < deadline:
                pump(sdk, self.camera)
                time.sleep(0.05)
        try:
            shutter_mode = SHUTTER_COMPLETELY if self.focus_prepared else SHUTTER_COMPLETELY_NON_AF
            send_command(sdk, self.camera, CMD_PRESS_SHUTTER, shutter_mode, "Take picture")
        finally:
            send_command(sdk, self.camera, CMD_PRESS_SHUTTER, SHUTTER_OFF, "Release shutter")
            self.focus_prepared = False
            self.focus_attempted = False
        wait_until = time.time() + 20
        while time.time() < wait_until:
            pump(sdk, self.camera)
            saved = drain(sdk, dest_dir)
            jpeg = next((path for path in saved if path), "")
            if jpeg:
                return jpeg
            time.sleep(0.05)
        raise RuntimeError("The Canon camera did not send a JPEG. Set image quality to JPEG and try again.")

    def live_view_frame(self) -> bytes:
        """Download one EVF JPEG. An empty result means the next frame is not ready yet."""
        self.connect()
        sdk = self.sdk
        stream = c_void_p()
        evf_image = c_void_p()
        check(sdk, sdk.EdsCreateMemoryStream(c_uint64(0), byref(stream)), "Create Canon Live View stream")
        try:
            check(sdk, sdk.EdsCreateEvfImageRef(stream, byref(evf_image)), "Create Canon Live View image")
            error = sdk.EdsDownloadEvfImage(self.camera, evf_image)
            if error == EDS_ERR_OBJECT_NOTREADY:
                pump(sdk, self.camera)
                return b""
            check(sdk, error, "Download Canon Live View image")
            pointer = c_void_p()
            length = c_uint64()
            check(sdk, sdk.EdsGetPointer(stream, byref(pointer)), "Read Canon Live View buffer")
            check(sdk, sdk.EdsGetLength(stream, byref(length)), "Read Canon Live View length")
            if not pointer.value or length.value == 0:
                return b""
            return bytes((c_char * length.value).from_address(pointer.value))
        finally:
            if evf_image:
                sdk.EdsRelease(evf_image)
            if stream:
                sdk.EdsRelease(stream)


def guest_rect_to_video(crop: dict) -> tuple[float, float, float, float]:
    """Undo the booth's cover-fit, rotation, and mirror to get capture-card pixels."""
    frame_w = max(1.0, float(crop["frameWidth"]))
    frame_h = max(1.0, float(crop["frameHeight"]))
    video_w = max(1.0, float(crop["videoWidth"]))
    video_h = max(1.0, float(crop["videoHeight"]))
    rotation = int(crop.get("rotation") or 0)
    mirror = bool(crop.get("mirror"))
    sideways = rotation in (90, 270)
    visual_w = video_h if sideways else video_w
    visual_h = video_w if sideways else video_h
    scale = max(frame_w / visual_w, frame_h / visual_h)
    draw_w = video_w * scale
    draw_h = video_h * scale
    theta = rotation * math.pi / 180
    cos_t = math.cos(theta)
    sin_t = math.sin(theta)

    def invert(px: float, py: float) -> tuple[float, float]:
        rx = px - frame_w / 2
        ry = py - frame_h / 2
        ix = rx * cos_t + ry * sin_t
        iy = -rx * sin_t + ry * cos_t
        if mirror:
            ix = -ix
        return (ix + draw_w / 2) / scale, (iy + draw_h / 2) / scale

    x = float(crop["x"])
    y = float(crop["y"])
    w = float(crop["width"])
    h = float(crop["height"])
    corners = [invert(x, y), invert(x + w, y), invert(x, y + h), invert(x + w, y + h)]
    xs = [point[0] for point in corners]
    ys = [point[1] for point in corners]
    left = min(max(0.0, min(xs)), video_w - 1)
    top = min(max(0.0, min(ys)), video_h - 1)
    right = min(video_w, max(xs))
    bottom = min(video_h, max(ys))
    return left, top, max(1.0, right - left), max(1.0, bottom - top)


def video_rect_to_still(
    video_box: tuple[float, float, float, float],
    video_w: float,
    video_h: float,
    still_w: float,
    still_h: float,
    framing: str,
) -> tuple[float, float, float, float]:
    vx, vy, vw, vh = video_box
    if framing == "contain":
        still_aspect = still_w / still_h
        video_aspect = video_w / video_h
        if still_aspect > video_aspect:
            shown_w = video_w
            shown_h = video_w / still_aspect
            shown_x = 0.0
            shown_y = (video_h - shown_h) / 2
        else:
            shown_h = video_h
            shown_w = video_h * still_aspect
            shown_x = (video_w - shown_w) / 2
            shown_y = 0.0
        left = max(vx, shown_x)
        top = max(vy, shown_y)
        right = min(vx + vw, shown_x + shown_w)
        bottom = min(vy + vh, shown_y + shown_h)
        if right <= left or bottom <= top:
            left, top, right, bottom = shown_x, shown_y, shown_x + shown_w, shown_y + shown_h
        return (
            (left - shown_x) / shown_w * still_w,
            (top - shown_y) / shown_h * still_h,
            (right - left) / shown_w * still_w,
            (bottom - top) / shown_h * still_h,
        )
    video_aspect = video_w / video_h
    still_aspect = still_w / still_h
    if still_aspect > video_aspect:
        region_h = still_h
        region_w = still_h * video_aspect
        region_x = (still_w - region_w) / 2
        region_y = 0.0
    else:
        region_w = still_w
        region_h = still_w / video_aspect
        region_x = 0.0
        region_y = (still_h - region_h) / 2
    return (
        region_x + (vx / video_w) * region_w,
        region_y + (vy / video_h) * region_h,
        (vw / video_w) * region_w,
        (vh / video_h) * region_h,
    )


def crop_still(path: str, crop: dict) -> tuple[str, int, int]:
    from PIL import Image, ImageOps

    with Image.open(path) as image:
        # EDSDK Live View and the downloaded JPEG begin in the same raw sensor
        # orientation. Reproduce the renderer transform directly on the still:
        # raw horizontal mirror first, then the configured clockwise rotation.
        # Applying EXIF orientation before this calculation mixes portrait still
        # coordinates with landscape EVF coordinates and shifts the crop.
        transformed = image.convert("RGB")
        if crop.get("mirror"):
            transformed = ImageOps.mirror(transformed)
        rotation = int(crop.get("rotation") or 0) % 360
        if rotation:
            transformed = transformed.rotate(-rotation, expand=True)

        still_w, still_h = transformed.size
        frame_w = max(1.0, float(crop["frameWidth"]))
        frame_h = max(1.0, float(crop["frameHeight"]))
        scale = max(frame_w / still_w, frame_h / still_h)
        draw_w = still_w * scale
        draw_h = still_h * scale
        offset_x = (frame_w - draw_w) / 2
        offset_y = (frame_h - draw_h) / 2

        left = (float(crop["x"]) - offset_x) / scale
        top = (float(crop["y"]) - offset_y) / scale
        right = (float(crop["x"]) + float(crop["width"]) - offset_x) / scale
        bottom = (float(crop["y"]) + float(crop["height"]) - offset_y) / scale
        left = max(0.0, min(left, still_w - 1))
        top = max(0.0, min(top, still_h - 1))
        right = max(left + 1, min(still_w, right))
        bottom = max(top + 1, min(still_h, bottom))
        cropped = transformed.crop((int(left), int(top), int(right), int(bottom)))
        aspect = float(crop.get("slotAspect") or 0)
        if aspect > 0:
            cropped = cover_crop(cropped, aspect, crop.get("cropY") == "top")
        out_path = os.path.splitext(path)[0] + "-crop.jpg"
        cropped.convert("RGB").save(out_path, format="JPEG", quality=95, subsampling=0)
        width, height = cropped.size
    try:
        os.remove(path)
    except OSError:
        pass
    return out_path, width, height


def cover_crop(image, aspect: float, crop_top: bool):
    width, height = image.size
    source_aspect = width / max(1, height)
    if source_aspect > aspect:
        crop_w = height * aspect
        offset_x = (width - crop_w) / 2
        offset_y = 0
        crop_h = height
    else:
        crop_h = width / aspect
        offset_x = 0
        offset_y = 0 if crop_top else (height - crop_h) / 2
        crop_w = width
    return image.crop(
        (
            int(offset_x),
            int(offset_y),
            int(offset_x + crop_w),
            int(offset_y + crop_h),
        )
    )


def reply(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main() -> None:
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        reply({"ok": False, "error": "Pillow is not installed. Run: py -3 -m pip install pillow"})
        time.sleep(5)
        return
    try:
        sdk = load_sdk()
    except Exception as error:
        reply({"ok": False, "error": str(error)})
        time.sleep(5)
        return
    camera = Camera(sdk)
    commands: queue.Queue = queue.Queue()

    def read_stdin() -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                commands.put(json.loads(line))
            except json.JSONDecodeError:
                reply({"ok": False, "id": None, "error": "Invalid command."})

    threading.Thread(target=read_stdin, daemon=True).start()
    reply({"ok": True, "ready": True})
    while True:
        if camera.ready:
            pump(sdk, camera.camera)
            try:
                for stray in drain(sdk, os.environ.get("TEMP") or "."):
                    try:
                        os.remove(stray)
                    except OSError:
                        pass
            except Exception:
                traceback.print_exc(file=sys.stderr)
        try:
            command = commands.get(timeout=0.05)
        except queue.Empty:
            continue
        request_id = command.get("id")
        name = command.get("cmd")
        try:
            if name == "status":
                model = camera.model if camera.ready else ""
                reply({"ok": True, "id": request_id, "connected": camera.ready, "model": model})
            elif name == "connect":
                model = camera.connect()
                reply({"ok": True, "id": request_id, "connected": True, "model": model})
            elif name == "live_frame":
                frame = camera.live_view_frame()
                reply({
                    "ok": True,
                    "id": request_id,
                    "dataUrl": f"data:image/jpeg;base64,{base64.b64encode(frame).decode('ascii')}" if frame else "",
                })
            elif name == "prepare_capture":
                camera.prepare_capture()
                reply({"ok": True, "id": request_id})
            elif name == "release_focus":
                camera.release_focus()
                reply({"ok": True, "id": request_id})
            elif name == "take":
                dest = command.get("dest") or os.path.join(os.environ.get("TEMP") or ".", "photo-booth-canon")
                path = camera.take(dest)
                cropped, width, height = crop_still(path, command.get("crop") or {})
                reply({"ok": True, "id": request_id, "path": cropped, "width": width, "height": height})
            elif name == "shutdown":
                camera.close()
                reply({"ok": True, "id": request_id})
                return
            else:
                reply({"ok": False, "id": request_id, "error": f"Unknown command {name}."})
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            reply({"ok": False, "id": request_id, "error": str(error)})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        reply({"ok": False, "error": str(error)})
