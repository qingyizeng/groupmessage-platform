import type { AccountStatus } from './accountTransitions';
import type { UserRole } from './types';

/** Response shapes of the REST API (section 2.3), shared by server and console. */

export interface MeDto {
  username: string;
  role: UserRole;
}

export interface AccountDto {
  id: string;
  status: AccountStatus;
  platformUserId: string | null;
  rateLimitedUntil: string | null;
}

export type MemberRole = 'creator' | 'admin' | 'member';
export type GroupStatus = 'active' | 'unreachable' | 'left';

export interface GroupDto {
  id: string;
  gatewayGroupId: string | null;
  status: GroupStatus;
  creatorAccountId: string | null;
  agentEnabled: boolean;
  autoKickEnabled: boolean;
  members: { accountId: string | null; platformUserId: string; role: MemberRole }[];
  activeSequenceRunId: string | null;
  activeAgentRunId: string | null;
}

export type DeliveryStatus = 'queued' | 'accepted' | 'sent' | 'failed' | 'unknown' | 'cancelled';

export interface MessageDto {
  id: number;
  msgId: string | null;
  clientMsgId: string | null;
  senderPlatformUserId: string | null;
  accountId: string | null;
  isOwn: boolean;
  text: string;
  sentAt: string;
  deliveryStatus: DeliveryStatus | null;
  failCode: string | null;
  mediaUrl: string | null;
  mediaStatus: 'pending' | 'downloaded' | 'expired' | 'failed' | 'deleted' | null;
  source: string | null;
}

export interface TimelinePageDto {
  items: MessageDto[];
  nextCursor: string | null;
}

export interface JobDto {
  id: string;
  type: 'create_group' | 'leave_all';
  status: 'running' | 'finished' | 'failed';
  groupId: string | null;
  errors: { step: string; code: string }[];
  createdAt: string;
  updatedAt: string;
}

export type AgentRunStatus = 'running' | 'finished' | 'failed' | 'blocked' | 'cancelled';
export type AgentEndReason = 'final' | 'budget_exhausted' | 'wall_clock' | 'protocol_errors' | 'audit_blocked' | 'cancelled';

export interface AgentStepDto {
  seq: number;
  kind: 'tool_use' | 'final' | 'protocol_error';
  toolUseId: string | null;
  name: string | null;
  input: unknown;
  resultSummary: string | null;
  isError: boolean;
  errorCode: string | null;
  auditVerdict: string | null;
  rawResponse: string | null;
  createdAt: string;
}

export interface AgentRunDto {
  id: string;
  groupId: string;
  status: AgentRunStatus;
  endReason: AgentEndReason | null;
  summary: string | null;
  stepCount: number;
  triggerMessages: { msgId: string; senderPlatformUserId: string; text: string; sentAt: string }[];
  createdAt: string;
  finishedAt: string | null;
  steps?: AgentStepDto[];
}

export interface SequenceDto {
  id: string;
  name: string;
  steps: { index: number; accountRole: 'admin' | 'member'; text: string; delaySeconds: number }[];
  createdAt: string;
}

export type SequenceRunStatus = 'running' | 'finished' | 'failed' | 'stopped';
export type SequenceStepStatus = 'pending' | 'accepted' | 'sent' | 'skipped' | 'failed';

export interface SequenceRunDto {
  id: string;
  groupId: string;
  sequenceId: string;
  status: SequenceRunStatus;
  currentStepIndex: number | null;
  vars: Record<string, string>;
  stepVars: Record<string, Record<string, string>>;
  createdAt: string;
  finishedAt: string | null;
  steps?: {
    index: number;
    status: SequenceStepStatus;
    accountRole: string;
    text: string;
    delaySeconds: number;
    scheduledAt: string | null;
    sentAt: string | null;
    skippedAt: string | null;
    accountId: string | null;
    clientMsgId: string | null;
    failCode: string | null;
    resolvedVars: Record<string, string>;
    varSources: Record<string, string>;
  }[];
}
