import { buildMockAgent } from './agent';

const port = Number(process.env.PORT ?? 4002);
const { app } = buildMockAgent({ logger: true });
await app.listen({ port, host: '0.0.0.0' });
