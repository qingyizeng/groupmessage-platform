import type {
  AccountDto,
  AccountStatus,
  AgentRunDto,
  GroupDto,
  JobDto,
  MeDto,
  SequenceDef,
  SequenceDto,
  SequenceRunDto,
  TimelinePageDto,
} from '@gmp/shared';
import { HttpClient } from './http';

export const http = new HttpClient({
  onSessionLost: () => {
    if (window.location.pathname !== '/login') window.location.assign('/login');
  },
});

const enc = encodeURIComponent;

export const api = {
  me: () => http.get<MeDto>('/api/auth/me'),

  accounts: () => http.get<AccountDto[]>('/api/accounts'),
  connect: (id: string) => http.post<{ status: AccountStatus }>(`/api/accounts/${enc(id)}/connect`),
  transition: (id: string, to: AccountStatus, expectedFrom: AccountStatus) =>
    http.post<{ status: AccountStatus }>(`/api/accounts/${enc(id)}/transition`, { to, expectedFrom }),

  groups: () => http.get<GroupDto[]>('/api/groups'),
  group: (id: string) => http.get<GroupDto>(`/api/groups/${enc(id)}`),
  createGroup: (creatorAccountId: string, memberAccountIds: string[]) =>
    http.post<{ jobId: string }>('/api/groups', { creatorAccountId, memberAccountIds }),
  patchGroup: (id: string, changes: { agentEnabled?: boolean; autoKickEnabled?: boolean }) =>
    http.patch<GroupDto>(`/api/groups/${enc(id)}`, changes),
  leaveAll: (id: string) => http.post<{ jobId: string }>(`/api/groups/${enc(id)}/leave-all`),
  send: (id: string, accountId: string, text: string) =>
    http.post<{ clientMsgId: string }>(`/api/groups/${enc(id)}/send`, { accountId, text }),
  messages: (id: string, before?: string, limit = 50) =>
    http.get<TimelinePageDto>(
      `/api/groups/${enc(id)}/messages?limit=${limit}${before ? `&before=${enc(before)}` : ''}`,
    ),

  job: (id: string) => http.get<JobDto>(`/api/jobs/${enc(id)}`),

  agentRuns: (groupId: string) => http.get<AgentRunDto[]>(`/api/groups/${enc(groupId)}/agent-runs`),
  agentRun: (id: string) => http.get<AgentRunDto>(`/api/agent-runs/${enc(id)}`),

  sequences: () => http.get<SequenceDto[]>('/api/sequences'),
  createSequence: (def: SequenceDef) => http.post<{ id: string }>('/api/sequences', def),
  startSequence: (
    groupId: string,
    sequenceId: string,
    vars: Record<string, string>,
    stepVars: Record<string, Record<string, string>>,
  ) => http.post<{ runId: string }>(`/api/groups/${enc(groupId)}/sequence-runs`, { sequenceId, vars, stepVars }),
  sequenceRun: (id: string) => http.get<SequenceRunDto>(`/api/sequence-runs/${enc(id)}`),
  groupSequenceRuns: (groupId: string) => http.get<SequenceRunDto[]>(`/api/groups/${enc(groupId)}/sequence-runs`),
};
