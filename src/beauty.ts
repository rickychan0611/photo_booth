import { FaceLandmarker, FilesetResolver, type NormalizedLandmark } from '@mediapipe/tasks-vision';

// Dedicated IMAGE-mode landmarker for retouching still photos. The live face
// asset tracker in faceAssets.ts runs in VIDEO mode, and a single landmarker
// instance cannot mix running modes, so beauty keeps its own instance with
// iris refinement enabled (needed for accurate eye centers/enlargement).
let beautyLandmarkerPromise: Promise<FaceLandmarker> | null = null;

const mediapipeUrl = (path: string) => new URL(`./mediapipe/${path}`, window.location.href).toString();
const mediapipeFolderUrl = (path: string) => new URL(`./mediapipe/${path}/`, window.location.href).toString();

const loadBeautyLandmarker = () => {
  beautyLandmarkerPromise ??= (async () => {
    const vision = await FilesetResolver.forVisionTasks(mediapipeFolderUrl('wasm'));
    const create = (delegate: 'GPU' | 'CPU') =>
      FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: mediapipeUrl('models/face_landmarker.task'),
          delegate
        },
        runningMode: 'IMAGE',
        numFaces: 8,
        minFaceDetectionConfidence: 0.3,
        minFacePresenceConfidence: 0.3,
        minTrackingConfidence: 0.3
      });
    try {
      return await create('GPU');
    } catch (error) {
      console.warn('MediaPipe beauty GPU delegate failed; falling back to CPU.', error);
      return create('CPU');
    }
  })().catch((error) => {
    beautyLandmarkerPromise = null;
    throw error;
  });
  return beautyLandmarkerPromise;
};

// MediaPipe FaceMesh landmark indices.
const LEFT_IRIS_CENTER = 468;
const RIGHT_IRIS_CENTER = 473;
const LEFT_EYE_OUTER = 33;
const LEFT_EYE_INNER = 133;
const LEFT_EYE_TOP = 159;
const LEFT_EYE_BOTTOM = 145;
const RIGHT_EYE_OUTER = 263;
const RIGHT_EYE_INNER = 362;
const RIGHT_EYE_TOP = 386;
const RIGHT_EYE_BOTTOM = 374;
const CHIN = 152;
const FOREHEAD_TOP = 10;
const LEFT_CHEEK = 234;
const RIGHT_CHEEK = 454;
const MOUTH_LEFT = 61;
const MOUTH_RIGHT = 291;
const MOUTH_TOP = 0;
const MOUTH_BOTTOM = 17;

// Ordered ring of the face oval for masking.
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
  378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
  162, 21, 54, 103, 67, 109
];

type Pt = { x: number; y: number };

type BeautyStrength = {
  eye: number;
  slim: number;
  chin: number;
  smoothAlpha: number;
  smoothBlurScale: number;
  whitenBrightness: number;
  whitenAlpha: number;
};

// Per-level tuning (level 1..4). Asian-beauty leaning: progressively larger
// eyes, slimmer jaw, pointier chin, softer + brighter skin.
const strengthForLevel = (level: number): BeautyStrength => {
  const n = Math.min(4, Math.max(1, level));
  return {
    eye: 0.05 * n, // up to ~0.20 magnification at the iris
    slim: 0.0225 * n, // up to ~0.09 horizontal jaw compression
    chin: 0.0175 * n, // extra taper toward the chin tip
    smoothAlpha: Math.min(0.62, 0.16 + n * 0.12),
    smoothBlurScale: 0.006 + n * 0.0035, // multiplied by face width (px)
    whitenBrightness: 0.05 * n, // skin brightness lift (filter brightness 1+..)
    whitenAlpha: Math.min(0.55, 0.14 + n * 0.1)
  };
};

const px = (landmark: NormalizedLandmark, width: number, height: number): Pt => ({
  x: landmark.x * width,
  y: landmark.y * height
});

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

const sampleBilinear = (
  src: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  dest: Uint8ClampedArray,
  destIndex: number
) => {
  if (x < 0) x = 0;
  else if (x > width - 1) x = width - 1;
  if (y < 0) y = 0;
  else if (y > height - 1) y = height - 1;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;

  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;

  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  for (let c = 0; c < 4; c += 1) {
    dest[destIndex + c] =
      src[i00 + c] * w00 + src[i10 + c] * w10 + src[i01 + c] * w01 + src[i11 + c] * w11;
  }
};

const smoothstep = (edge0: number, edge1: number, value: number) => {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

type FaceGeometry = {
  midX: number;
  faceWidth: number;
  faceTopY: number;
  chinY: number;
  cheekTopY: number;
  leftEye: { center: Pt; radius: number };
  rightEye: { center: Pt; radius: number };
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
};

const buildGeometry = (
  landmarks: NormalizedLandmark[],
  width: number,
  height: number
): FaceGeometry | null => {
  const at = (index: number) => (landmarks[index] ? px(landmarks[index], width, height) : null);

  const leftCheek = at(LEFT_CHEEK);
  const rightCheek = at(RIGHT_CHEEK);
  const chin = at(CHIN);
  const forehead = at(FOREHEAD_TOP);
  if (!leftCheek || !rightCheek || !chin || !forehead) return null;

  const leftOuter = at(LEFT_EYE_OUTER);
  const leftInner = at(LEFT_EYE_INNER);
  const rightOuter = at(RIGHT_EYE_OUTER);
  const rightInner = at(RIGHT_EYE_INNER);
  if (!leftOuter || !leftInner || !rightOuter || !rightInner) return null;

  const leftIris = at(LEFT_IRIS_CENTER);
  const rightIris = at(RIGHT_IRIS_CENTER);
  const leftEyeCenter = leftIris ?? {
    x: (leftOuter.x + leftInner.x) / 2,
    y: (leftOuter.y + leftInner.y) / 2
  };
  const rightEyeCenter = rightIris ?? {
    x: (rightOuter.x + rightInner.x) / 2,
    y: (rightOuter.y + rightInner.y) / 2
  };
  const leftEyeWidth = dist(leftOuter, leftInner);
  const rightEyeWidth = dist(rightOuter, rightInner);

  const faceWidth = dist(leftCheek, rightCheek);
  const midX = (leftCheek.x + rightCheek.x) / 2;
  const eyeY = (leftEyeCenter.y + rightEyeCenter.y) / 2;

  const minX = Math.min(leftCheek.x, rightCheek.x, chin.x, forehead.x);
  const maxX = Math.max(leftCheek.x, rightCheek.x, chin.x, forehead.x);
  const margin = faceWidth * 0.35;

  return {
    midX,
    faceWidth,
    faceTopY: forehead.y,
    chinY: chin.y,
    cheekTopY: eyeY,
    leftEye: { center: leftEyeCenter, radius: Math.max(8, leftEyeWidth * 0.95) },
    rightEye: { center: rightEyeCenter, radius: Math.max(8, rightEyeWidth * 0.95) },
    bbox: {
      minX: Math.max(0, Math.floor(minX - margin)),
      minY: Math.max(0, Math.floor(forehead.y - margin)),
      maxX: Math.min(width - 1, Math.ceil(maxX + margin)),
      maxY: Math.min(height - 1, Math.ceil(chin.y + margin * 1.2))
    }
  };
};

// Backward-mapping warp: for each destination pixel work out which source pixel
// to sample so the result has bigger eyes and a slimmer jaw/chin.
const warpFaces = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  faces: FaceGeometry[],
  strength: BeautyStrength
) => {
  const source = ctx.getImageData(0, 0, width, height);
  const src = source.data;
  const dest = new ImageData(new Uint8ClampedArray(src), width, height);
  const out = dest.data;

  for (const face of faces) {
    const { bbox } = face;
    const slimRange = Math.max(1, face.faceWidth * 0.85);

    for (let y = bbox.minY; y <= bbox.maxY; y += 1) {
      for (let x = bbox.minX; x <= bbox.maxX; x += 1) {
        let sx = x;
        let sy = y;

        // Eye enlargement takes precedence inside the iris radius.
        let handledByEye = false;
        for (const eye of [face.leftEye, face.rightEye]) {
          const dx = x - eye.center.x;
          const dy = y - eye.center.y;
          const d = Math.hypot(dx, dy);
          if (d < eye.radius) {
            const t = d / eye.radius;
            // scale < 1 pulls the sample toward the eye center => magnify.
            const scale = 1 - strength.eye * (1 - t * t);
            sx = eye.center.x + dx * scale;
            sy = eye.center.y + dy * scale;
            handledByEye = true;
            break;
          }
        }

        if (!handledByEye) {
          // Vertical influence: none above the eyes, full around the jaw,
          // with an extra pinch toward the chin tip.
          const vWeight = smoothstep(face.cheekTopY, face.chinY, y);
          if (vWeight > 0) {
            const dx = x - face.midX;
            const hFall = 1 - smoothstep(slimRange * 0.55, slimRange, Math.abs(dx));
            if (hFall > 0) {
              const chinWeight = smoothstep(
                face.cheekTopY + (face.chinY - face.cheekTopY) * 0.55,
                face.chinY,
                y
              );
              const squeeze = (strength.slim * vWeight + strength.chin * chinWeight) * hFall;
              const factor = 1 / (1 - Math.min(0.6, squeeze));
              sx = face.midX + dx * factor;
            }
          }
        }

        if (sx !== x || sy !== y) {
          const di = (y * width + x) * 4;
          sampleBilinear(src, width, height, sx, sy, out, di);
        }
      }
    }
  }

  ctx.putImageData(dest, 0, 0);
};

// Face-masked skin smoothing. Blurs a copy of the photo but only blends it back
// over face skin, with eyes and mouth cut out so they stay crisp.
const smoothSkin = (
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  faceLandmarks: NormalizedLandmark[][],
  faces: FaceGeometry[],
  strength: BeautyStrength
) => {
  const avgFaceWidth =
    faces.reduce((sum, face) => sum + face.faceWidth, 0) / Math.max(1, faces.length);
  const blurPx = Math.max(1.5, avgFaceWidth * strength.smoothBlurScale);

  // Blurred copy of the whole photo.
  const blurCanvas = document.createElement('canvas');
  blurCanvas.width = width;
  blurCanvas.height = height;
  const blurCtx = blurCanvas.getContext('2d');
  if (!blurCtx) return;
  blurCtx.filter = `blur(${blurPx}px)`;
  blurCtx.drawImage(canvas, 0, 0);
  blurCtx.filter = 'none';

  // Mask: white over face skin, holes punched for eyes and mouth.
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) return;

  maskCtx.fillStyle = '#fff';
  faceLandmarks.forEach((landmarks) => {
    maskCtx.beginPath();
    FACE_OVAL.forEach((index, order) => {
      const landmark = landmarks[index];
      if (!landmark) return;
      const point = px(landmark, width, height);
      if (order === 0) maskCtx.moveTo(point.x, point.y);
      else maskCtx.lineTo(point.x, point.y);
    });
    maskCtx.closePath();
    maskCtx.fill();
  });

  const eraseEllipse = (landmarks: NormalizedLandmark[], indices: number[], grow: number) => {
    const pts = indices.map((index) => landmarks[index]).filter(Boolean) as NormalizedLandmark[];
    if (pts.length < 2) return;
    const xs = pts.map((p) => p.x * width);
    const ys = pts.map((p) => p.y * height);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const rx = ((Math.max(...xs) - Math.min(...xs)) / 2) * grow + 4;
    const ry = ((Math.max(...ys) - Math.min(...ys)) / 2) * grow + 4;
    maskCtx.beginPath();
    maskCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    maskCtx.fill();
  };

  maskCtx.globalCompositeOperation = 'destination-out';
  maskCtx.fillStyle = '#fff';
  faceLandmarks.forEach((landmarks) => {
    eraseEllipse(landmarks, [LEFT_EYE_OUTER, LEFT_EYE_INNER, LEFT_EYE_TOP, LEFT_EYE_BOTTOM], 1.7);
    eraseEllipse(landmarks, [RIGHT_EYE_OUTER, RIGHT_EYE_INNER, RIGHT_EYE_TOP, RIGHT_EYE_BOTTOM], 1.7);
    eraseEllipse(landmarks, [MOUTH_LEFT, MOUTH_RIGHT, MOUTH_TOP, MOUTH_BOTTOM], 1.5);
  });
  maskCtx.globalCompositeOperation = 'source-over';

  // Feather the mask edges so smoothing fades in/out smoothly.
  const featherPx = Math.max(2, avgFaceWidth * 0.03);
  const featherCanvas = document.createElement('canvas');
  featherCanvas.width = width;
  featherCanvas.height = height;
  const featherCtx = featherCanvas.getContext('2d');
  if (!featherCtx) return;
  featherCtx.filter = `blur(${featherPx}px)`;
  featherCtx.drawImage(maskCanvas, 0, 0);
  featherCtx.filter = 'none';

  // Keep only the blurred pixels that fall inside the feathered mask.
  blurCtx.globalCompositeOperation = 'destination-in';
  blurCtx.drawImage(featherCanvas, 0, 0);
  blurCtx.globalCompositeOperation = 'source-over';

  // Blend the masked, blurred skin back over the original.
  ctx.save();
  ctx.globalAlpha = strength.smoothAlpha;
  ctx.drawImage(blurCanvas, 0, 0);
  ctx.restore();

  // Skin whitening: brighten + slightly desaturate a copy of the (now smoothed)
  // photo and blend it back only inside the feathered skin mask.
  if (strength.whitenBrightness > 0 && strength.whitenAlpha > 0) {
    const whitenCanvas = document.createElement('canvas');
    whitenCanvas.width = width;
    whitenCanvas.height = height;
    const whitenCtx = whitenCanvas.getContext('2d');
    if (whitenCtx) {
      whitenCtx.filter = `brightness(${1 + strength.whitenBrightness}) saturate(${1 - strength.whitenBrightness * 0.4})`;
      whitenCtx.drawImage(canvas, 0, 0);
      whitenCtx.filter = 'none';
      whitenCtx.globalCompositeOperation = 'destination-in';
      whitenCtx.drawImage(featherCanvas, 0, 0);
      whitenCtx.globalCompositeOperation = 'source-over';

      ctx.save();
      ctx.globalAlpha = strength.whitenAlpha;
      ctx.drawImage(whitenCanvas, 0, 0);
      ctx.restore();
    }
  }
};

// Detects faces on the canvas and applies the beauty retouch in place. Returns
// true if a face was found and processed, false otherwise (caller can fall back
// or simply leave the photo untouched).
export const applyFaceBeauty = async (
  canvas: HTMLCanvasElement,
  level: number
): Promise<boolean> => {
  if (level <= 0) return false;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  let landmarker: FaceLandmarker;
  try {
    landmarker = await loadBeautyLandmarker();
  } catch (error) {
    console.warn('Beauty landmarker unavailable; skipping retouch.', error);
    return false;
  }

  let result;
  try {
    result = landmarker.detect(canvas);
  } catch (error) {
    console.warn('Beauty face detection failed; skipping retouch.', error);
    return false;
  }

  const faceLandmarks = result?.faceLandmarks ?? [];
  if (faceLandmarks.length === 0) return false;

  const strength = strengthForLevel(level);
  const geometries = faceLandmarks
    .map((landmarks) => buildGeometry(landmarks, canvas.width, canvas.height))
    .filter((geometry): geometry is FaceGeometry => geometry !== null);
  if (geometries.length === 0) return false;

  // Geometry first (eyes/slim/chin), then skin smoothing over the result.
  warpFaces(ctx, canvas.width, canvas.height, geometries, strength);
  smoothSkin(canvas, ctx, canvas.width, canvas.height, faceLandmarks, geometries, strength);
  return true;
};
