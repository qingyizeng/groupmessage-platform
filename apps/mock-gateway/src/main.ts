import { buildMockGateway, FAST_TIMINGS, REALISTIC_TIMINGS } from './gateway';

const port = Number(process.env.PORT ?? 4001);
const gateway = buildMockGateway({
  timings: process.env.MOCK_TIMINGS === 'fast' ? FAST_TIMINGS : REALISTIC_TIMINGS,
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
  logger: true,
});

await gateway.app.listen({ port, host: '0.0.0.0' });
