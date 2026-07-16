export type AcousticSpeaker = 1 | 2
export type IdentitySource = 'voiceprint' | 'session' | 'unmatched'

export interface VoiceprintEvidence {
  matched: boolean
  score: number
  confidence?: number
  name?: string | null
}

export interface IdentityDecision {
  speaker: 1 | 2
  confidence: number
  staffName?: string
  voiceprintMatched: boolean
  identityResolved: boolean
  identitySource?: IdentitySource
}

export function createSpeakerIdentityResolver() {
  function provisional(_acousticSpeaker: AcousticSpeaker, acousticConfidence: number): IdentityDecision {
    return {
      speaker: 1,
      confidence: acousticConfidence,
      voiceprintMatched: false,
      identityResolved: false,
    }
  }

  function resolve(_acousticSpeaker: AcousticSpeaker, acousticConfidence: number, match: VoiceprintEvidence): IdentityDecision {
    const score = match.confidence ?? match.score
    if (match.matched) {
      return {
        speaker: 2,
        confidence: score,
        staffName: match.name || undefined,
        voiceprintMatched: true,
        identityResolved: true,
        identitySource: 'voiceprint',
      }
    }

    return {
      speaker: 1,
      confidence: acousticConfidence,
      voiceprintMatched: false,
      identityResolved: true,
      identitySource: 'unmatched',
    }
  }

  return { provisional, resolve }
}
