import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Descriptions, Space, Steps, Table, Tag, Typography } from 'antd';
import type { SequenceRunDto } from '@gmp/shared';
import { api } from '../api/client';
import { errorText, fmtTime, SEQ_RUN_COLOR, SEQ_STEP_COLOR } from '../lib/format';

type Step = NonNullable<SequenceRunDto['steps']>[number];

const STEP_STATE: Record<string, 'wait' | 'process' | 'finish' | 'error'> = {
  pending: 'wait',
  accepted: 'process',
  sent: 'finish',
  skipped: 'finish',
  failed: 'error',
};

/** Live progress of one sequence run (refreshed by sequence_run events). */
export function SequenceRunPage() {
  const { id = '' } = useParams();
  const run = useQuery({ queryKey: ['sequenceRun', id], queryFn: () => api.sequenceRun(id) });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  if (run.error) return <Alert type="error" message={errorText(run.error)} />;
  const r = run.data;
  if (!r) return <Card loading />;
  const steps = r.steps ?? [];
  const current = steps.find((s) => s.index === r.currentStepIndex);

  const countdown = (s: Step) => {
    if (s.status !== 'pending' || !s.scheduledAt || s.clientMsgId) return null;
    const left = Math.max(0, Date.parse(s.scheduledAt) - now);
    return `${(left / 1000).toFixed(1)}s 后发送`;
  };

  return (
    <Card title={`序列运行 ${r.id.slice(0, 8)}`} extra={<Link to={`/groups/${r.groupId}`}>返回群</Link>}>
      {r.status === 'stopped' && <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="群变为不可写，序列已停止。" />}
      <Descriptions size="small" column={3} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="状态">
          <Tag color={SEQ_RUN_COLOR[r.status]} data-testid="seq-run-status">
            {r.status}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="当前步">{r.currentStepIndex ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="开始">{fmtTime(r.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="vars" span={3}>
          <Typography.Text code>{JSON.stringify(r.vars)}</Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="stepVars" span={3}>
          <Typography.Text code>{JSON.stringify(r.stepVars)}</Typography.Text>
        </Descriptions.Item>
      </Descriptions>

      <Steps
        size="small"
        style={{ marginBottom: 24 }}
        current={steps.findIndex((s) => s.index === r.currentStepIndex)}
        items={steps.map((s) => ({
          title: `第 ${s.index} 步`,
          status: r.status === 'running' && s === current && s.status === 'pending' ? 'process' : STEP_STATE[s.status],
          description: s.status === 'skipped' ? '已跳过' : (countdown(s) ?? s.status),
        }))}
      />

      <Table<Step>
        size="small"
        rowKey="index"
        pagination={false}
        dataSource={steps}
        data-testid="seq-steps"
        columns={[
          { title: '#', dataIndex: 'index', width: 40 },
          { title: '角色', dataIndex: 'accountRole', width: 80 },
          { title: '账号', dataIndex: 'accountId', width: 90, render: (v: string | null) => v ?? '—' },
          { title: '文本', dataIndex: 'text' },
          {
            title: '状态',
            dataIndex: 'status',
            width: 150,
            render: (st: string, s) => (
              <Space size={4}>
                <Tag color={SEQ_STEP_COLOR[st]} data-testid="seq-step-status">
                  {st}
                </Tag>
                {s.failCode && <Tag color="red">{s.failCode}</Tag>}
              </Space>
            ),
          },
          { title: '计划时间', dataIndex: 'scheduledAt', width: 150, render: (v: string | null, s) => countdown(s) ?? fmtTime(v) },
          { title: '发出/跳过时间', dataIndex: 'sentAt', width: 150, render: fmtTime },
          {
            title: '取值与来源',
            key: 'vars',
            render: (_: unknown, s) =>
              Object.entries(s.resolvedVars).map(([k, v]) => (
                <div key={k}>
                  <Typography.Text code>{k}</Typography.Text>={v} <Tag>{s.varSources[k]}</Tag>
                </div>
              )),
          },
        ]}
      />
    </Card>
  );
}
