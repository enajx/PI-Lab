/**
 * Whisper models offered for local dictation. Each file comes from the
 * ggerganov/whisper.cpp Hugging Face repository; the byte size and SHA-256 are
 * pinned from that repository's LFS metadata so a download is verified before use.
 */
export interface DictationModel {
  key: string
  name: string
  url: string
  sizeBytes: number
  sha256: string
  multilingual: boolean
  recommended: boolean
}

const MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

/** Build one catalog entry from its key and pinned file metadata. */
function model(
  key: string,
  name: string,
  sizeBytes: number,
  sha256: string,
  recommended: boolean,
): DictationModel {
  return {
    key,
    name,
    url: `${MODEL_BASE_URL}/ggml-${key}.bin`,
    sizeBytes,
    sha256,
    multilingual: !key.endsWith(".en"),
    recommended,
  }
}

export const DICTATION_MODELS: readonly DictationModel[] = [
  model(
    "tiny.en",
    "Tiny English",
    77704715,
    "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
    false,
  ),
  model(
    "base.en",
    "Base English",
    147964211,
    "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    false,
  ),
  model(
    "small.en",
    "Small English",
    487614201,
    "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
    true,
  ),
  model(
    "medium.en",
    "Medium English",
    1533774781,
    "cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356",
    false,
  ),
  model(
    "tiny",
    "Tiny Multilingual",
    77691713,
    "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    false,
  ),
  model(
    "base",
    "Base Multilingual",
    147951465,
    "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    false,
  ),
  model(
    "small",
    "Small Multilingual",
    487601967,
    "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    false,
  ),
  model(
    "medium",
    "Medium Multilingual",
    1533763059,
    "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
    false,
  ),
  model(
    "large-v3-turbo",
    "Large v3 Turbo",
    1624555275,
    "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    false,
  ),
]

/** Decimal size label as shown in the UI, for example "488 MB" or "1.5 GB". */
export function sizeLabel(bytes: number): string {
  if (bytes < 1e9) return `${Math.round(bytes / 1e6)} MB`
  return `${(bytes / 1e9).toFixed(1)} GB`
}

/**
 * Test mode only (`PI_LAB_TEST_DICTATION_PINS`): replace the pinned byte size and SHA-256
 * of some models, given as JSON `{ "<key>": { "sizeBytes": n, "sha256": "..." } }`, so an
 * end-to-end test can serve a small real model in place of a large one.
 */
export function withTestPins(
  catalog: readonly DictationModel[],
  json: string,
): readonly DictationModel[] {
  const pins = JSON.parse(json) as Record<string, { sizeBytes: number; sha256: string }>
  return catalog.map((entry) => {
    const pin = pins[entry.key]
    return pin ? { ...entry, sizeBytes: pin.sizeBytes, sha256: pin.sha256 } : entry
  })
}
