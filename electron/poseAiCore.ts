import crypto from 'node:crypto';
import type { AppSettings } from './types';
import {
  type ParticipantRole,
  type PoseAiGenerateRequest,
  type PoseAiGenerateResult,
  type PoseAiProvider,
  type PoseFraming,
  type PoseScene,
  type PoseStyle
} from './poseTypes';
import { validateScene } from './poseValidation';

const ROLES: ParticipantRole[] = ['men', 'women', 'boys', 'girls', 'adult', 'child', 'any'];
const STYLES: PoseStyle[] = ['solo', 'couple', 'friends', 'family', 'group'];
const FRAMING: PoseFraming[] = ['full', 'half'];

type PosePlanCaption = { progress: number; text: string };
type PosePlanRole = { role: ParticipantRole; repeatable: boolean };
export type PoseAiPlan = {
  name: string;
  category: string;
  tags: string[];
  instruction: string;
  introCaption: string;
  durationMs: number;
  compatibility: { minPeople: number; maxPeople: number; styles: PoseStyle[]; framing: PoseFraming[]; childSafe: boolean };
  roles: PosePlanRole[];
  captions: PosePlanCaption[];
};

const number = (minimum: number, maximum: number, description: string) => ({ type: 'number', minimum, maximum, description });
const string = (description: string) => ({ type: 'string', description });
const enumString = (values: readonly string[], description: string) => ({ type: 'string', enum: values, description });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });

const captionSchema = object({
  progress: number(.15, 1, 'Position within the four-second guide. Captions must increase and the final caption must be 1, which is shown from two seconds through the hold.'),
  text: string('Short guest instruction for this beat.')
});
const roleSchema = object({
  role: enumString(ROLES, 'Guest type eligible for this place in the pose.'),
  repeatable: { type: 'boolean', description: 'Whether this role can repeat for a flexible group.' }
});

export const POSE_AI_PLAN_SCHEMA = object({
  name: string('Friendly pose name.'),
  category: string('Pose library category.'),
  tags: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
  instruction: string('One-sentence summary of the complete pose.'),
  introCaption: string('First instruction, shown at the start.'),
  durationMs: { type: 'integer', const: 4000, description: 'Four-second photo guide. The final caption is reached at two seconds and then held.' },
  compatibility: object({
    minPeople: { type: 'integer', minimum: 1, maximum: 12 },
    maxPeople: { type: 'integer', minimum: 0, maximum: 12, description: 'Use 0 for a flexible group.' },
    styles: { type: 'array', minItems: 1, maxItems: STYLES.length, items: enumString(STYLES, 'Supported guest relationship style.') },
    framing: { type: 'array', minItems: 1, maxItems: 2, items: enumString(FRAMING, 'Supported photo framing.') },
    childSafe: { type: 'boolean' }
  }),
  roles: { type: 'array', minItems: 1, maxItems: 12, items: roleSchema },
  captions: { type: 'array', minItems: 2, maxItems: 4, items: captionSchema }
});

const SYSTEM_PROMPT = `You design safe, fun photo-booth pose challenges shown as still photo cutouts with timed captions. Return only the requested structured pose plan.

Do not describe a skeleton, joints, or character animation. Write 2-4 short captions with strictly increasing progress; the final progress is exactly 1 and is displayed from 2.0 seconds through 4.0 seconds. Match roles to the people in the pose. Use child or any when the pose is child-safe, and adult when it is not. Do not include audio or an image path.`;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown, minimum: number, maximum: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
const oneOf = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === 'string' && values.includes(value as T);
const text = (value: unknown, name: string, maximum = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`AI pose plan has invalid ${name}.`);
  return value.trim();
};

export function validatePoseAiPlan(value: unknown): PoseAiPlan {
  if (!isRecord(value)) throw new Error('AI provider did not return a pose plan.');
  const compatibility = value.compatibility;
  if (!isRecord(compatibility)) throw new Error('AI pose plan has invalid compatibility.');
  const minPeople = compatibility.minPeople, maxPeople = compatibility.maxPeople;
  if (!Number.isInteger(minPeople) || !finite(minPeople, 1, 12) || !Number.isInteger(maxPeople) || !finite(maxPeople, 0, 12) || (maxPeople !== 0 && maxPeople < minPeople)) throw new Error('AI pose plan has invalid people limits.');
  if (!Array.isArray(compatibility.styles) || !compatibility.styles.length || compatibility.styles.some(item => !oneOf(item, STYLES))) throw new Error('AI pose plan has invalid styles.');
  if (!Array.isArray(compatibility.framing) || !compatibility.framing.length || compatibility.framing.some(item => !oneOf(item, FRAMING))) throw new Error('AI pose plan has invalid framing.');
  if (typeof compatibility.childSafe !== 'boolean') throw new Error('AI pose plan has invalid child safety.');
  if (value.durationMs !== 4000) throw new Error('AI pose plan duration must be 4000 ms.');
  if (!Array.isArray(value.tags) || !value.tags.length || value.tags.length > 8) throw new Error('AI pose plan has invalid tags.');
  const tags = value.tags.map((tag, index) => text(tag, `tag ${index + 1}`, 40));
  if (!Array.isArray(value.roles) || !value.roles.length || value.roles.length > 12) throw new Error('AI pose plan has invalid roles.');
  const roles = value.roles.map((raw, index): PosePlanRole => {
    if (!isRecord(raw) || !oneOf(raw.role, ROLES) || typeof raw.repeatable !== 'boolean') throw new Error(`AI pose plan has invalid role ${index + 1}.`);
    return { role: raw.role, repeatable: raw.repeatable };
  });
  if (!Array.isArray(value.captions) || value.captions.length < 2 || value.captions.length > 4) throw new Error('AI pose plan has invalid captions.');
  let previous = 0;
  const captions = value.captions.map((raw, index): PosePlanCaption => {
    if (!isRecord(raw) || !finite(raw.progress, .15, 1) || raw.progress <= previous) throw new Error('AI pose plan has unordered captions.');
    previous = raw.progress;
    return { progress: raw.progress, text: text(raw.text, `caption ${index + 1}`, 100) };
  });
  if (Math.abs(captions.at(-1)!.progress - 1) > .0001) throw new Error('AI pose plan must end at progress 1.');
  if (maxPeople === 0 && !roles.some(role => role.repeatable)) roles[roles.length - 1].repeatable = true;
  return {
    name: text(value.name, 'name', 80), category: text(value.category, 'category', 40), tags,
    instruction: text(value.instruction, 'instruction', 240), introCaption: text(value.introCaption, 'intro caption', 100), durationMs: value.durationMs,
    compatibility: { minPeople, maxPeople, styles: compatibility.styles as PoseStyle[], framing: compatibility.framing as PoseFraming[], childSafe: compatibility.childSafe },
    roles, captions
  };
}

const slug = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'pose';
export function compilePoseAiPlan(value: unknown, provider: PoseAiProvider = 'openai'): PoseScene {
  const plan = validatePoseAiPlan(value);
  const scene: PoseScene = {
    schemaVersion: 2, id: `ai-${slug(plan.name)}-${crypto.randomUUID().slice(0, 8)}`,
    name: plan.name, category: plan.category, tags: [...new Set([...plan.tags, 'ai-generated', provider])], instruction: plan.instruction,
    compatibility: { ...plan.compatibility, maxPeople: plan.compatibility.maxPeople === 0 ? null : plan.compatibility.maxPeople },
    roles: plan.roles,
    animation: { durationMs: plan.durationMs, captions: [{ timeMs: 0, text: plan.introCaption }, ...plan.captions.map(caption => ({ timeMs: Math.round(caption.progress * 2000), text: caption.text }))] }
  };
  const uniqueCaptions = new Map(scene.animation.captions.map(caption => [caption.timeMs, caption]));
  scene.animation.captions = [...uniqueCaptions.values()].sort((a, b) => a.timeMs - b.timeMs);
  return validateScene(scene);
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const extractText = (body: unknown): string => {
  if (!isRecord(body)) return '';
  for (const direct of [body.output_text, body.outputText]) if (typeof direct === 'string') return direct;
  if (isRecord(body.interaction)) {
    for (const direct of [body.interaction.output_text, body.interaction.outputText]) if (typeof direct === 'string') return direct;
  }
  if (Array.isArray(body.output)) for (const item of body.output) if (isRecord(item) && Array.isArray(item.content)) for (const content of item.content) if (isRecord(content) && typeof content.text === 'string') return content.text;
  if (Array.isArray(body.candidates)) for (const candidate of body.candidates) if (isRecord(candidate) && isRecord(candidate.content) && Array.isArray(candidate.content.parts)) for (const part of candidate.content.parts) if (isRecord(part) && typeof part.text === 'string') return part.text;
  if (Array.isArray(body.choices)) for (const choice of body.choices) if (isRecord(choice) && isRecord(choice.message) && typeof choice.message.content === 'string') return choice.message.content;
  return '';
};

const errorMessage = (body: unknown, status: number) => isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string' ? body.error.message : `AI pose request failed (${status}).`;
async function requestPlan(provider: PoseAiProvider, apiUrl: string, model: string, apiKey: string, description: string, fetcher: Fetcher) {
  const prompt = `${SYSTEM_PROMPT}\n\nGuest request:\n${description}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: Record<string, unknown>;
  if (provider === 'gemini') {
    headers['x-goog-api-key'] = apiKey;
    body = { model, input: prompt, response_format: { type: 'text', mime_type: 'application/json', schema: POSE_AI_PLAN_SCHEMA } };
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
    body = { model, input: prompt, text: { format: { type: 'json_schema', name: 'photo_booth_pose_plan', schema: POSE_AI_PLAN_SCHEMA, strict: true } } };
  }
  const response = await fetcher(apiUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  let responseBody: unknown;
  try { responseBody = await response.json(); } catch { throw new Error(`AI pose provider returned unreadable data (${response.status}).`); }
  if (!response.ok) throw new Error(errorMessage(responseBody, response.status));
  const output = extractText(responseBody);
  if (!output) throw new Error('AI pose provider returned no JSON.');
  try { return JSON.parse(output); } catch { throw new Error('AI pose provider returned invalid JSON.'); }
}

export async function generatePoseFromDescription(request: PoseAiGenerateRequest, settings: AppSettings, fetcher: Fetcher = fetch): Promise<PoseAiGenerateResult> {
  const description = text(request.description, 'description', 4000);
  if (description.length < 12) throw new Error('Describe the pose in a little more detail.');
  const provider = request.provider ?? settings.ai.poseGenerator.provider;
  if (!oneOf(provider, ['openai', 'gemini', 'xai'] as const)) throw new Error('Choose a supported AI pose provider.');
  const credentials = settings.ai.providers[provider], config = settings.ai.poseGenerator.providers[provider];
  if (!credentials.enabled) throw new Error(`${provider} is not enabled in AI Presets.`);
  if (!credentials.apiKey.trim()) throw new Error(`${provider} API key is missing in AI Presets.`);
  if (!config.apiUrl.trim() || !config.model.trim()) throw new Error(`${provider} pose model settings are incomplete.`);
  const plan = await requestPlan(provider, config.apiUrl, config.model, credentials.apiKey.trim(), description, fetcher);
  return { scene: compilePoseAiPlan(plan, provider), provider, model: config.model };
}
