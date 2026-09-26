import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Col, Descriptions, Form, Input, Popconfirm, Row, Select, Space, Switch, Table, Tag } from 'antd';
import type { AgentRunDto, GroupDto } from '@gmp/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { JobStatus } from '../components/JobStatus';
import { Timeline } from '../components/Timeline';
import { errorText, fmtTime, RUN_STATUS_COLOR } from '../lib/format';

export function GroupDetailPage() {
  const { id = '' } = useParams();
  const { canWrite } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const group = useQuery({ queryKey: ['group', id], queryFn: () => api.group(id) });
  const runs = useQuery({ queryKey: ['agentRuns', id], queryFn: () => api.agentRuns(id) });
  const [leaveJob, setLeaveJob] = useState<string | null>(null);

  const patch = useMutation({
    mutationFn: (changes: { agentEnabled?: boolean; autoKickEnabled?: boolean }) => api.patchGroup(id, changes),
    onSuccess: (g) => qc.setQueryData(['group', id], g),
    onError: (err) => message.error(errorText(err)),
  });
  const leaveAll = useMutation({
    mutationFn: () => api.leaveAll(id),
    onSuccess: ({ jobId }) => setLeaveJob(jobId),
    onError: (err) => message.error(errorText(err)),
  });

  const g = group.data;
  if (group.error) return <Alert type="error" message={errorText(group.error)} />;
  if (!g) return <Card loading />;
  const blocked = (runs.data ?? []).filter((r) => r.status === 'blocked');

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {blocked.length > 0 && (
        <Alert
          type="error"
          showIcon
          data-testid="blocked-alert"
          message={`有 ${blocked.length} 个 agent run 因审计无结论被阻断`}
          description={
            <Space wrap>
              {blocked.map((r) => (
                <Link key={r.id} to={`/agent-runs/${r.id}`}>
                  {r.id.slice(0, 8)}（{fmtTime(r.createdAt)}）
                </Link>
              ))}
            </Space>
          }
        />
      )}
      {g.status === 'unreachable' && <Alert type="warning" showIcon message="该群不可写（被解散或禁言），序列和 agent 已停止。" />}
      {leaveJob && <JobStatus jobId={leaveJob} label="全员退群" />}

      <Card
        title={`群 ${g.id.slice(0, 8)}`}
        extra={
          canWrite &&
          g.status !== 'left' && (
            <Popconfirm title="让所有服务账号退出该群？群主最后退出。" onConfirm={() => leaveAll.mutate()}>
              <Button danger loading={leaveAll.isPending}>
                全员退群
              </Button>
            </Popconfirm>
          )
        }
      >
        <Descriptions size="small" column={3}>
          <Descriptions.Item label="状态">
            <Tag color={g.status === 'active' ? 'green' : g.status === 'unreachable' ? 'red' : 'default'}>{g.status}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="网关群 id">{g.gatewayGroupId}</Descriptions.Item>
          <Descriptions.Item label="群主">{g.creatorAccountId}</Descriptions.Item>
          <Descriptions.Item label="Agent">
            <Switch
              checked={g.agentEnabled}
              disabled={!canWrite || patch.isPending}
              onChange={(v) => patch.mutate({ agentEnabled: v })}
              data-testid="agent-switch"
            />
          </Descriptions.Item>
          <Descriptions.Item label="自动踢人">
            <Switch
              checked={g.autoKickEnabled}
              disabled={!canWrite || patch.isPending}
              onChange={(v) => patch.mutate({ autoKickEnabled: v })}
            />
          </Descriptions.Item>
          <Descriptions.Item label="运行中">
            <Space size={8}>
              {g.activeAgentRunId && <Link to={`/agent-runs/${g.activeAgentRunId}`}>agent run</Link>}
              {g.activeSequenceRunId && <Link to={`/sequence-runs/${g.activeSequenceRunId}`}>序列运行</Link>}
              {!g.activeAgentRunId && !g.activeSequenceRunId && '—'}
              {g.status === 'active' && <Link to={`/sequences?groupId=${g.id}`}>发起序列</Link>}
            </Space>
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Row gutter={16}>
        <Col span={16}>
          <Card title="消息时间线">
            <Timeline groupId={g.id} />
            {canWrite && g.status === 'active' && <SendForm group={g} />}
          </Card>
        </Col>
        <Col span={8}>
          <Card title="成员" style={{ marginBottom: 16 }}>
            <Table
              size="small"
              rowKey="platformUserId"
              pagination={false}
              dataSource={g.members}
              data-testid="members"
              columns={[
                { title: '账号', dataIndex: 'accountId', render: (v: string | null) => v ?? <Tag>外部用户</Tag> },
                { title: 'platformUserId', dataIndex: 'platformUserId', ellipsis: true },
                {
                  title: '角色',
                  dataIndex: 'role',
                  render: (r: string) => <Tag color={r === 'creator' ? 'gold' : r === 'admin' ? 'blue' : 'default'}>{r}</Tag>,
                },
              ]}
            />
          </Card>
          <Card title="最近的 agent run">
            <Table<AgentRunDto>
              size="small"
              rowKey="id"
              pagination={false}
              loading={runs.isLoading}
              dataSource={runs.data}
              data-testid="agent-runs"
              rowClassName={(r) => (r.status === 'blocked' ? 'row-blocked' : '')}
              columns={[
                { title: 'run', dataIndex: 'id', render: (rid: string) => <Link to={`/agent-runs/${rid}`}>{rid.slice(0, 8)}</Link> },
                {
                  title: '状态',
                  dataIndex: 'status',
                  render: (s: string) => (
                    <Tag color={RUN_STATUS_COLOR[s]} data-testid="agent-run-status">
                      {s}
                    </Tag>
                  ),
                },
                { title: 'endReason', dataIndex: 'endReason', render: (v: string | null) => v ?? '—' },
                { title: '步数', dataIndex: 'stepCount' },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

function SendForm({ group }: { group: GroupDto }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ accountId: string; text: string }>();
  const accounts = group.members.filter((m) => m.accountId).map((m) => ({ value: m.accountId!, label: `${m.accountId}（${m.role}）` }));
  const send = useMutation({
    mutationFn: (v: { accountId: string; text: string }) => api.send(group.id, v.accountId, v.text),
    onSuccess: () => form.setFieldValue('text', ''),
    onError: (err) => message.error(errorText(err)),
  });
  return (
    <Form form={form} layout="inline" style={{ marginTop: 12 }} onFinish={(v) => send.mutate(v)}>
      <Form.Item name="accountId" rules={[{ required: true, message: '选择账号' }]}>
        <Select style={{ width: 180 }} placeholder="以哪个账号发送" options={accounts} data-testid="send-account" />
      </Form.Item>
      <Form.Item name="text" rules={[{ required: true, whitespace: true, message: '输入消息' }]} style={{ flex: 1 }}>
        <Input placeholder="消息内容" maxLength={4000} data-testid="send-text" />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={send.isPending} data-testid="send-button">
        发送
      </Button>
    </Form>
  );
}
