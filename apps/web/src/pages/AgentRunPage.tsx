import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Descriptions, Table, Tag, Typography } from 'antd';
import type { AgentStepDto } from '@gmp/shared';
import { api } from '../api/client';
import { errorText, fmtTime, RUN_STATUS_COLOR } from '../lib/format';

const KIND_COLOR: Record<string, string> = { tool_use: 'blue', final: 'green', protocol_error: 'red' };

export function AgentRunPage() {
  const { id = '' } = useParams();
  const run = useQuery({ queryKey: ['agentRun', id], queryFn: () => api.agentRun(id) });
  if (run.error) return <Alert type="error" message={errorText(run.error)} />;
  const r = run.data;
  if (!r) return <Card loading />;

  return (
    <Card title={`Agent run ${r.id.slice(0, 8)}`} extra={<Link to={`/groups/${r.groupId}`}>返回群</Link>}>
      {r.status === 'blocked' && (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} message="该 run 因审计 3 次无明确结论被阻断，对应工具未执行。" />
      )}
      <Descriptions size="small" column={3} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="状态">
          <Tag color={RUN_STATUS_COLOR[r.status]} data-testid="run-status">
            {r.status}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="endReason">{r.endReason ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="步数">{r.stepCount}</Descriptions.Item>
        <Descriptions.Item label="创建">{fmtTime(r.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="结束">{fmtTime(r.finishedAt)}</Descriptions.Item>
        <Descriptions.Item label="summary">{r.summary ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="触发消息" span={3}>
          {r.triggerMessages.map((m) => `${m.senderPlatformUserId}: ${m.text}`).join(' / ')}
        </Descriptions.Item>
      </Descriptions>
      <Table<AgentStepDto>
        rowKey="seq"
        size="small"
        pagination={false}
        dataSource={r.steps}
        data-testid="agent-steps"
        expandable={{
          rowExpandable: (s) => Boolean(s.rawResponse),
          expandedRowRender: (s) => (
            <div>
              <Typography.Text type="secondary">Agent 服务原始响应体（截断到 2KB）：</Typography.Text>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }} data-testid="raw-response">
                {s.rawResponse}
              </pre>
            </div>
          ),
        }}
        columns={[
          { title: '#', dataIndex: 'seq', width: 48 },
          {
            title: 'kind',
            dataIndex: 'kind',
            render: (k: string) => (
              <Tag color={KIND_COLOR[k]} data-testid="step-kind">
                {k}
              </Tag>
            ),
          },
          { title: '工具', dataIndex: 'name', render: (v: string | null) => v ?? '—' },
          {
            title: '入参',
            dataIndex: 'input',
            render: (v: unknown) =>
              v === null ? '—' : <pre style={{ margin: 0, maxWidth: 260, whiteSpace: 'pre-wrap' }}>{JSON.stringify(v, null, 1)}</pre>,
          },
          {
            title: '结果摘要',
            dataIndex: 'resultSummary',
            render: (v: string | null) => <span style={{ wordBreak: 'break-all' }}>{v ?? '—'}</span>,
          },
          { title: '审计', dataIndex: 'auditVerdict', width: 90, render: (v: string | null) => (v ? <Tag>{v}</Tag> : '—') },
          {
            title: '错误码',
            dataIndex: 'errorCode',
            width: 150,
            render: (v: string | null, s) => (s.isError ? <Tag color="red">{v}</Tag> : '—'),
          },
        ]}
      />
    </Card>
  );
}
