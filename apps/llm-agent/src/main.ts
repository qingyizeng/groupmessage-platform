import Anthropic from '@anthropic-ai/sdk';
import { buildLlmAgent } from './agent';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const effort = (process.env.LLM_EFFORT ?? 'low') as (typeof EFFORTS)[number];
if (!EFFORTS.includes(effort)) throw new Error(`LLM_EFFORT must be one of ${EFFORTS.join(', ')}`);

// Credentials come from the environment (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile).
// The platform gives a turn 10–15 s, so keep the SDK's own timeout and retries below that budget.
const client = new Anthropic({ timeout: 11_000, maxRetries: 1 });
const app = buildLlmAgent({ client, model: process.env.LLM_MODEL ?? 'claude-opus-5', effort, logger: true });

await app.listen({ port: Number(process.env.PORT ?? 4003), host: '0.0.0.0' });
