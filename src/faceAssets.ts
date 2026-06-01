import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult, type ImageSource, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { AppSettings, CameraRotation, FaceAsset, FaceAssetPack, TemplateDesign } from './types';

let faceLandmarkerPromise: Promise<FaceLandmarker> | null = null;
const imageCache = new Map<string, Promise<HTMLImageElement>>();

const mediapipeUrl = (path: string) => new URL(`./mediapipe/${path}`, window.location.href).toString();
const mediapipeFolderUrl = (path: string) => new URL(`./mediapipe/${path}/`, window.location.href).toString();

export const selectedFaceAssetPack = (settings: AppSettings, design: TemplateDesign | null) => {
  if (!design?.faceTrackingEnabled || !design.faceAssetPackId) return null;
  const pack = settings.template.faceAssetPacks.find((candidate) => candidate.id === design.faceAssetPackId);
  if (!pack?.active) return null;
  if (!pack.assets.some((asset) => asset.active)) return null;
  return pack;
};

export const loadFaceLandmarker = () => {
  faceLandmarkerPromise ??= (async () => {
    const vision = await FilesetResolver.forVisionTasks(mediapipeFolderUrl('wasm'));
    const create = (delegate: 'GPU' | 'CPU') =>
      FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: mediapipeUrl('models/face_landmarker.task'),
          delegate
      },
      runningMode: 'VIDEO',
      numFaces: 6,
      minFaceDetectionConfidence: 0.28,
      minFacePresenceConfidence: 0.28,
      minTrackingConfidence: 0.28,
      outputFacialTransformationMatrixes: true
    });
    try {
      return await create('GPU');
    } catch (error) {
      console.warn('MediaPipe GPU delegate failed; falling back to CPU.', error);
      return create('CPU');
    }
  })().catch((error) => {
    faceLandmarkerPromise = null;
    throw error;
  });
  return faceLandmarkerPromise;
};

export const detectFaces = async (source: ImageSource, timestamp = performance.now()) => {
  const landmarker = await loadFaceLandmarker();
  return landmarker.detectForVideo(source, timestamp);
};

export const clearFaceAssetCanvas = (canvas: HTMLCanvasElement, width: number, height: number) => {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx?.clearRect(0, 0, canvas.width, canvas.height);
};

export class FaceAssetStabilizer {
  private transforms = new Map<string, FaceAssetTransform>();

  smooth(key: string, next: FaceAssetTransform) {
    const previous = this.transforms.get(key);
    if (!previous) {
      this.transforms.set(key, next);
      return next;
    }
    const smoothed = {
      x: lerp(previous.x, next.x, 0.32),
      y: lerp(previous.y, next.y, 0.32),
      width: lerp(previous.width, next.width, 0.28),
      height: lerp(previous.height, next.height, 0.28),
      rotation: smoothAngle(previous.rotation, next.rotation, 0.26, 0.1)
    };
    this.transforms.set(key, smoothed);
    return smoothed;
  }

  reset() {
    this.transforms.clear();
  }
}

export const drawFaceAssets = async (
  ctx: CanvasRenderingContext2D,
  result: FaceLandmarkerResult | null,
  pack: FaceAssetPack | null,
  width: number,
  height: number,
  stabilizer?: FaceAssetStabilizer
) => {
  if (!result || !pack) return;
  const assets = pack.assets
    .filter((asset) => asset.active)
    .sort((a, b) => a.order - b.order);
  if (assets.length === 0) return;

  const faces = result.faceLandmarks
    .slice(0, 6)
    .sort((a, b) => faceBounds(a, width, height).x - faceBounds(b, width, height).x);
  for (const [faceIndex, landmarks] of faces.entries()) {
    for (const asset of assets) {
      await drawAsset(ctx, asset, landmarks, width, height, stabilizer, `${faceIndex}:${asset.id}`);
    }
  }
};

export const drawFaceDebugInfo = (
  ctx: CanvasRenderingContext2D,
  result: FaceLandmarkerResult | null,
  width: number,
  height: number
) => {
  if (!result) return;
  ctx.save();
  ctx.font = '22px Arial';
  ctx.lineWidth = 3;
  ctx.textBaseline = 'top';

  result.faceLandmarks.slice(0, 6).forEach((landmarks, index) => {
    const face = createFaceGeometry(landmarks, width, height);
    const rollDegrees = (face.roll * 180) / Math.PI;
    const label = `FACE ${index + 1}  x:${Math.round(face.eyeCenter.x)} y:${Math.round(face.eyeCenter.y)}  roll:${rollDegrees.toFixed(1)}deg`;
    const labelX = Math.max(18, Math.min(width - 520, face.eyeCenter.x - 220));
    const labelY = Math.max(18, face.bounds.top - 78);

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillStyle = 'rgba(255, 228, 92, 0.95)';
    ctx.strokeText(label, labelX, labelY);
    ctx.fillText(label, labelX, labelY);

    drawDebugLine(ctx, face.eyeCenter, moveInFaceSpace(face.eyeCenter, face.right, face.down, face.faceWidth * 0.38, 0), '#54d6ff');
    drawDebugLine(ctx, face.eyeCenter, moveInFaceSpace(face.eyeCenter, face.right, face.down, 0, face.faceHeight * 0.22), '#ff6ad5');
    drawDebugPoint(ctx, face.eyeCenter, '#ffe45c', 'eyes');
    drawDebugPoint(ctx, face.nose, '#72ff7d', 'nose');
    drawDebugPoint(ctx, face.mouth, '#ff8f5a', 'mouth');
    drawDebugPoint(ctx, moveInFaceSpace(face.eyeCenter, face.right, face.down, 0, -face.faceHeight * 0.42), '#b88cff', 'hat');
  });

  ctx.restore();
};

export const drawFaceAssetsOnCanvas = async (
  canvas: HTMLCanvasElement,
  result: FaceLandmarkerResult | null,
  pack: FaceAssetPack | null
) => {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  await drawFaceAssets(ctx, result, pack, canvas.width, canvas.height);
};

export const mapFaceResultToDisplay = (
  result: FaceLandmarkerResult,
  sourceWidth: number,
  sourceHeight: number,
  displayWidth: number,
  displayHeight: number,
  options: { mirror: boolean; rotation: CameraRotation }
): FaceLandmarkerResult => ({
  ...result,
  faceLandmarks: result.faceLandmarks.map((landmarks) =>
    landmarks.map((landmark) => {
      const point = sourcePointToDisplay(
        landmark.x * sourceWidth,
        landmark.y * sourceHeight,
        sourceWidth,
        sourceHeight,
        displayWidth,
        displayHeight,
        options
      );
      return {
        ...landmark,
        x: point.x / Math.max(1, displayWidth),
        y: point.y / Math.max(1, displayHeight)
      };
    })
  )
});

const drawAsset = async (
  ctx: CanvasRenderingContext2D,
  asset: FaceAsset,
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
  stabilizer?: FaceAssetStabilizer,
  stabilizerKey?: string
) => {
  const image = await loadAssetImage(asset.path);
  let transform = assetTransform(asset, landmarks, width, height, image);
  if (!transform) return;
  if (stabilizer && stabilizerKey) transform = stabilizer.smooth(stabilizerKey, transform);
  ctx.save();
  ctx.globalAlpha = asset.opacity;
  ctx.translate(transform.x, transform.y);
  ctx.rotate(transform.rotation);
  ctx.drawImage(image, -transform.width / 2, -transform.height / 2, transform.width, transform.height);
  ctx.restore();
};

const drawDebugLine = (ctx: CanvasRenderingContext2D, from: Point, to: Point, color: string) => {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
};

const drawDebugPoint = (ctx: CanvasRenderingContext2D, point: Point, color: string, label: string) => {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.86)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(point.x, point.y, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.font = '16px Arial';
  ctx.textBaseline = 'top';
  ctx.strokeText(label, point.x + 10, point.y + 8);
  ctx.fillText(label, point.x + 10, point.y + 8);
  ctx.restore();
};

const loadAssetImage = (path: string) => {
  if (!imageCache.has(path)) {
    imageCache.set(path, window.photoBooth.getImageDataUrl(path).then(loadImage));
  }
  return imageCache.get(path)!;
};

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });

type Point = { x: number; y: number };

const landmarkPoint = (landmarks: NormalizedLandmark[], index: number, width: number, height: number) => {
  const point = landmarks[index];
  return point ? { x: point.x * width, y: point.y * height } : null;
};

const averageLandmarkPoint = (landmarks: NormalizedLandmark[], indexes: number[], width: number, height: number) => {
  const points = indexes
    .map((index) => landmarkPoint(landmarks, index, width, height))
    .filter(Boolean) as Array<{ x: number; y: number }>;
  if (points.length === 0) return null;
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  };
};

const midpoint = (a: Point, b: Point) => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2
});

const add = (a: Point, b: Point) => ({ x: a.x + b.x, y: a.y + b.y });

const scalePoint = (point: Point, scale: number) => ({ x: point.x * scale, y: point.y * scale });

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

const angle = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x);

type FaceAssetTransform = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
};

const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const smoothAngle = (from: number, to: number, amount: number, maxStep: number) => {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + clamp(delta * amount, -maxStep, maxStep);
};

const unitFromAngle = (radians: number) => ({ x: Math.cos(radians), y: Math.sin(radians) });

const normalFromRight = (right: Point) => ({ x: -right.y, y: right.x });

const moveInFaceSpace = (origin: Point, right: Point, down: Point, x: number, y: number) =>
  add(add(origin, scalePoint(right, x)), scalePoint(down, y));

const circularMean = (angles: number[]) => {
  if (angles.length === 0) return 0;
  const sum = angles.reduce(
    (next, value) => ({
      x: next.x + Math.cos(value),
      y: next.y + Math.sin(value)
    }),
    { x: 0, y: 0 }
  );
  return Math.atan2(sum.y, sum.x);
};

const angleDelta = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

const normalizeVisualRoll = (radians: number) => {
  let next = radians;
  while (next > Math.PI / 2) next -= Math.PI;
  while (next < -Math.PI / 2) next += Math.PI;
  return next;
};

const sourcePointToDisplay = (
  sourceX: number,
  sourceY: number,
  sourceWidth: number,
  sourceHeight: number,
  displayWidth: number,
  displayHeight: number,
  options: { mirror: boolean; rotation: CameraRotation }
) => {
  const rotated = options.rotation === 90 || options.rotation === 270;
  const boxWidth = rotated ? displayHeight : displayWidth;
  const boxHeight = rotated ? displayWidth : displayHeight;
  const scale = Math.max(boxWidth / sourceWidth, boxHeight / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  let x = (boxWidth - drawWidth) / 2 + sourceX * scale;
  let y = (boxHeight - drawHeight) / 2 + sourceY * scale;
  const centerX = boxWidth / 2;
  const centerY = boxHeight / 2;

  if (options.mirror) x = boxWidth - x;

  const dx = x - centerX;
  const dy = y - centerY;
  const radians = (options.rotation * Math.PI) / 180;
  const rotatedX = dx * Math.cos(radians) - dy * Math.sin(radians);
  const rotatedY = dx * Math.sin(radians) + dy * Math.cos(radians);
  const left = (displayWidth - boxWidth) / 2;
  const top = (displayHeight - boxHeight) / 2;

  return {
    x: left + centerX + rotatedX,
    y: top + centerY + rotatedY
  };
};

const faceBounds = (landmarks: NormalizedLandmark[], width: number, height: number) => {
  const points = landmarks.map((point) => ({ x: point.x * width, y: point.y * height }));
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return {
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    width: right - left,
    height: bottom - top,
    top,
    bottom
  };
};

const stableFaceAngle = (landmarks: NormalizedLandmark[], width: number, height: number) => {
  const pairs: Array<[number, number]> = [
    [33, 263],
    [133, 362],
    [159, 386],
    [145, 374],
    [70, 300],
    [105, 334],
    [61, 291],
    [78, 308]
  ];
  const angles = pairs.flatMap(([leftIndex, rightIndex]) => {
    const left = landmarkPoint(landmarks, leftIndex, width, height);
    const right = landmarkPoint(landmarks, rightIndex, width, height);
    return left && right ? [angle(left, right)] : [];
  });
  if (angles.length === 0) return 0;
  const primary = angles[0];
  const filtered = angles.filter((candidate) => Math.abs(angleDelta(primary, candidate)) < 0.52);
  return normalizeVisualRoll(circularMean(filtered.length > 0 ? filtered : angles.slice(0, 2)));
};

const createFaceGeometry = (landmarks: NormalizedLandmark[], width: number, height: number) => {
  const bounds = faceBounds(landmarks, width, height);
  const leftEye = averageLandmarkPoint(landmarks, [33, 133, 159, 145, 468, 469, 470, 471, 472], width, height);
  const rightEye = averageLandmarkPoint(landmarks, [263, 362, 386, 374, 473, 474, 475, 476, 477], width, height);
  const nose = averageLandmarkPoint(landmarks, [1, 4, 5, 195], width, height);
  const mouth = averageLandmarkPoint(landmarks, [13, 14, 61, 291, 78, 308], width, height);
  const chin = averageLandmarkPoint(landmarks, [152, 175, 199], width, height);
  const forehead = averageLandmarkPoint(landmarks, [10, 67, 297, 109, 338], width, height);
  const leftMouth = averageLandmarkPoint(landmarks, [61, 78, 191], width, height);
  const rightMouth = averageLandmarkPoint(landmarks, [291, 308, 415], width, height);
  const eyeCenter = leftEye && rightEye ? midpoint(leftEye, rightEye) : { x: bounds.x, y: bounds.top + bounds.height * 0.38 };
  const roll = stableFaceAngle(landmarks, width, height);
  const right = unitFromAngle(roll);
  const down = normalFromRight(right);
  const eyeDistance = leftEye && rightEye ? distance(leftEye, rightEye) : Math.max(1, bounds.width * 0.42);
  const mouthWidth = leftMouth && rightMouth ? distance(leftMouth, rightMouth) : eyeDistance * 0.78;
  const faceWidth = Math.max(eyeDistance * 2.45, bounds.width * 0.72, 1);
  const faceHeight = Math.max(bounds.height, eyeDistance * 3.1, 1);
  return {
    bounds,
    leftEye,
    rightEye,
    eyeCenter,
    nose: nose ?? { x: bounds.x, y: bounds.y },
    mouth: mouth ?? { x: bounds.x, y: bounds.y + faceHeight * 0.18 },
    chin: chin ?? { x: bounds.x, y: bounds.bottom },
    forehead: forehead ?? { x: bounds.x, y: bounds.top },
    right,
    down,
    roll,
    eyeDistance,
    mouthWidth,
    faceWidth,
    faceHeight
  };
};

const assetTransform = (
  asset: FaceAsset,
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
  image: HTMLImageElement
) => {
  const face = createFaceGeometry(landmarks, width, height);
  const aspect = image.naturalHeight / Math.max(1, image.naturalWidth);
  let anchor = { x: face.bounds.x, y: face.bounds.y };
  let assetWidth = face.faceWidth;

  if (asset.placement === 'glasses') {
    anchor = moveInFaceSpace(face.eyeCenter, face.right, face.down, 0, face.eyeDistance * 0.05);
    assetWidth = face.eyeDistance * 2.18;
  } else if (asset.placement === 'hat') {
    anchor = moveInFaceSpace(face.eyeCenter, face.right, face.down, 0, -face.faceHeight * 0.42);
    assetWidth = face.faceWidth * 1.3;
  } else if (asset.placement === 'nose') {
    anchor = face.nose;
    assetWidth = face.eyeDistance * 0.56;
  } else if (asset.placement === 'mouth') {
    anchor = face.mouth;
    assetWidth = face.mouthWidth * 1.62;
  } else if (asset.placement === 'face') {
    anchor = moveInFaceSpace(face.eyeCenter, face.right, face.down, 0, face.faceHeight * 0.18);
    assetWidth = face.faceWidth * 1.08;
  }

  assetWidth *= asset.scale;
  const positioned = moveInFaceSpace(
    anchor,
    face.right,
    face.down,
    asset.xOffset * face.faceWidth,
    asset.yOffset * face.faceHeight
  );
  return {
    x: positioned.x,
    y: positioned.y,
    width: assetWidth,
    height: assetWidth * aspect,
    rotation: face.roll + (asset.rotation * Math.PI) / 180
  };
};
