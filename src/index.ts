import config from '../gateway.config';
import { handleRequest } from './gateway';
import { durableQuota, QuotaCounter } from './quota-do';
import type { Env } from './types';

export { QuotaCounter };

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, config, { quota: durableQuota(env) });
  },
} satisfies ExportedHandler<Env>;
