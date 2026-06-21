'use client';

// Whether AI content generation is available to this business. Wraps the cheap
// GET /api/ai/status probe (no model call) — `available` is true only when the
// server has a provider configured (AWS Bedrock / Anthropic) AND the plan is
// entitled (Professional+). Use it to show/hide the "Generate with AI" buttons.
//
//   const { available } = useAiStatus();
//   {available && <AiGenerateButton ... />}

import { useApi } from '@/lib/useApi';

export function useAiStatus() {
  const { data, loading } = useApi('/api/ai/status');
  return {
    available: !!data?.available,
    configured: !!data?.configured,
    entitled: !!data?.entitled,
    model: data?.model || null,
    types: data?.types || [],
    loading,
  };
}
