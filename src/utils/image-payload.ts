import {
  getImageModelFamily,
  isV5MediumModel,
  Model,
  type ImageModelFamily,
} from "../constants";
import type { ImageGenerationRequest, Metadata } from "../types";

/** Fields only meaningful for V4/V4.5 models. */
const V4_ONLY_FIELDS = [
  "autoSmea",
  "use_coords",
  "legacy_uc",
  "normalize_reference_strength_multiple",
  "deliberate_euler_ancestral_bug",
  "prefer_brownian",
  "inpaintImg2ImgStrength",
  "v4_prompt",
  "v4_negative_prompt",
] as const;

/** Fields only meaningful for V5 models. */
const V5_ONLY_FIELDS = [
  "qualityPresetId",
  "ucPresetId",
  "tag_hint_qt",
  "tag_hint_uc_preset",
  "tag_hint_transparent_background",
  "straight_alpha",
] as const;

/**
 * Build the `/ai/generate-image` request body from processed metadata.
 *
 * The payload is projected per model family so V3/Furry, V4/V4.5 and V5
 * requests only contain the fields their protocol understands.
 */
export function buildImagePayload(metadata: Metadata): ImageGenerationRequest {
  const model = metadata.model!;
  return {
    input: metadata.prompt ?? "",
    model,
    action: metadata.action!,
    parameters: projectParameters(metadata),
  };
}

/**
 * Project the flat metadata object into the `parameters` object expected by
 * the image generation API.
 */
export function projectParameters(
  metadata: Metadata,
  family: ImageModelFamily = getImageModelFamily(metadata.model!),
): Record<string, unknown> {
  // JSON round-trip drops undefined values while preserving null.
  const params: Record<string, any> = JSON.parse(JSON.stringify(metadata));

  delete params.model;
  delete params.action;
  delete params.prompt;
  delete params.resPreset;

  if (family === "v3") {
    for (const field of V4_ONLY_FIELDS) delete params[field];
    for (const field of V5_ONLY_FIELDS) delete params[field];
  } else if (family === "v4") {
    delete params.sm;
    delete params.sm_dyn;
    for (const field of V5_ONLY_FIELDS) delete params[field];
  } else {
    delete params.sm;
    delete params.sm_dyn;
    delete params.qualityToggle;
    delete params.ucPreset;
    delete params.skip_cfg_above_sigma;
    params.params_version = 4;
    if (isV5MediumModel(metadata.model as Model)) {
      delete params.cfg_rescale;
    }
  }

  // Official web payloads keep the camelCase name; do not rename it to
  // `inpaint_img2img_strength`.
  if (params.inpaintImg2ImgStrength != null) {
    params.inpaintImg2ImgStrength = Number(params.inpaintImg2ImgStrength);
  }

  return params;
}
