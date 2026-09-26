import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Col, Empty, Form, Input, Modal, Row, Select, Space, Table, Tag, Typography } from 'antd';
import { placeholders, resolveSequence, validateSequence, type ResolveResult, type SequenceDef, type SequenceDto } from '@gmp/shared';
import { api } from '../api/client';
import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import { errorText, fmtTime, SEQ_RUN_COLOR } from '../lib/format';

const EXAMPLE: SequenceDef = {
  name: '活动提醒',
  steps: [
    { index: 1, accountRole: 'admin', text: '{event} 将于 {time} 开始，请提前准备', delaySeconds: 10 },
    { index: 2, accountRole: 'member', text: '提醒：{event} 的资料已上传到 {location}', delaySeconds: 5 },
  ],
};

/** Page 5: pick a sequence, fill vars / stepVars, preview the resolution, start, follow progress. */
export function SequencesPage() {
  const { canWrite } = useAuth();
  const [params, setParams] = useSearchParams();
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.groups });
  const sequences = useQuery({ queryKey: ['sequences'], queryFn: api.sequences });
  const [creating, setCreating] = useState(false);
  const groupId = params.get('groupId') ?? undefined;
  const sequenceId = params.get('sequenceId') ?? undefined;
  const sequence = sequences.data?.find((q) => q.id === sequenceId);
  const set = (k: string, v: string | undefined) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  return (
    <Row gutter={16}>
      <Col span={16}>
        <Card title="发起序列运行">
          <Space wrap style={{ marginBottom: 16 }}>
            <Select
              style={{ width: 280 }}
              placeholder="选择群"
              value={groupId}
              onChange={(v) => set('groupId', v)}
              data-testid="seq-group"
              options={(groups.data ?? []).map((g) => ({
                value: g.id,
                label: `${g.id.slice(0, 8)} · ${g.gatewayGroupId} · ${g.status}`,
                disabled: g.status !== 'active',
              }))}
            />
            <Select
              style={{ width: 280 }}
              placeholder="选择序列"
              value={sequenceId}
              onChange={(v) => set('sequenceId', v)}
              data-testid="seq-sequence"
              options={(sequences.data ?? []).map((q) => ({ value: q.id, label: `${q.name}（${q.steps.length} 步）` }))}
            />
          </Space>
          {sequence ? (
            <RunForm key={sequence.id} sequence={sequence} groupId={groupId} canWrite={canWrite} />
          ) : (
            <Empty description="先选择一个序列" />
          )}
        </Card>
        {groupId && <GroupRuns groupId={groupId} />}
      </Col>
      <Col span={8}>
        <Card
          title="序列"
          extra={
            canWrite && (
              <Button onClick={() => setCreating(true)} data-testid="new-sequence">
                新建序列
              </Button>
            )
          }
        >
          <Table<SequenceDto>
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={sequences.data}
            onRow={(q) => ({ onClick: () => set('sequenceId', q.id), style: { cursor: 'pointer' } })}
            columns={[
              { title: '名称', dataIndex: 'name' },
              { title: '步数', key: 'n', render: (_: unknown, q: SequenceDto) => q.steps.length },
              { title: '创建', dataIndex: 'createdAt', render: fmtTime },
            ]}
          />
        </Card>
      </Col>
      {canWrite && (
        <NewSequenceModal
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            set('sequenceId', id);
          }}
        />
      )}
    </Row>
  );
}

function RunForm({ sequence, groupId, canWrite }: { sequence: SequenceDto; groupId?: string; canWrite: boolean }) {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const keys = useMemo(() => [...new Set(sequence.steps.flatMap((s) => placeholders(s.text)))], [sequence]);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [stepVars, setStepVars] = useState<Record<string, Record<string, string>>>({});
  const [preview, setPreview] = useState<ResolveResult | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const cleanStepVars = () =>
    Object.fromEntries(
      Object.entries(stepVars)
        .map(([i, kv]) => [i, Object.fromEntries(Object.entries(kv).filter(([, v]) => v !== ''))] as const)
        .filter(([, kv]) => Object.keys(kv).length > 0),
    );

  const start = useMutation({
    mutationFn: () => api.startSequence(groupId!, sequence.id, vars, cleanStepVars()),
    onSuccess: ({ runId }) => {
      setPreview(null);
      navigate(`/sequence-runs/${runId}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'UNRESOLVED_PLACEHOLDER') {
        setServerError(`预检未通过：第 ${String(err.body.stepIndex)} 步的占位符 {${String(err.body.key)}} 没有取值`);
      } else {
        setServerError(errorText(err));
      }
      message.error(errorText(err));
    },
  });

  return (
    <div>
      <Table
        size="small"
        rowKey="index"
        pagination={false}
        dataSource={sequence.steps}
        style={{ marginBottom: 16 }}
        columns={[
          { title: '#', dataIndex: 'index', width: 40 },
          { title: '角色', dataIndex: 'accountRole', width: 80, render: (r: string) => <Tag>{r}</Tag> },
          { title: '延迟(秒)', dataIndex: 'delaySeconds', width: 80 },
          { title: '文本模板', dataIndex: 'text' },
          ...keys.map((k) => ({
            title: `stepVars.${k}`,
            key: k,
            width: 150,
            render: (_: unknown, s: { index: number }) => (
              <Input
                size="small"
                placeholder="不改"
                value={stepVars[String(s.index)]?.[k] ?? ''}
                data-testid={`stepvar-${s.index}-${k}`}
                onChange={(e) =>
                  setStepVars((prev) => ({ ...prev, [String(s.index)]: { ...prev[String(s.index)], [k]: e.target.value } }))
                }
              />
            ),
          })),
        ]}
      />
      <Typography.Text strong>vars（初始取值，空串视为未提供）</Typography.Text>
      <Form layout="inline" style={{ margin: '8px 0 16px' }}>
        {keys.length === 0 && <Typography.Text type="secondary">该序列没有占位符</Typography.Text>}
        {keys.map((k) => (
          <Form.Item key={k} label={k}>
            <Input
              value={vars[k] ?? ''}
              onChange={(e) => setVars((prev) => ({ ...prev, [k]: e.target.value }))}
              data-testid={`var-${k}`}
            />
          </Form.Item>
        ))}
      </Form>
      {serverError && <Alert type="error" showIcon message={serverError} style={{ marginBottom: 12 }} data-testid="start-error" />}
      <Button
        type="primary"
        disabled={!groupId}
        onClick={() => {
          setServerError(null);
          setPreview(resolveSequence(sequence.steps, vars, cleanStepVars()));
        }}
        data-testid="preflight"
      >
        预检
      </Button>
      {!groupId && <Typography.Text type="secondary"> 请先选择群</Typography.Text>}

      <Modal
        title="预检结果"
        open={preview !== null}
        width={860}
        onCancel={() => setPreview(null)}
        footer={[
          <Button key="cancel" onClick={() => setPreview(null)}>
            返回修改
          </Button>,
          canWrite && (
            <Button
              key="start"
              type="primary"
              disabled={!preview?.ok}
              loading={start.isPending}
              onClick={() => start.mutate()}
              data-testid="start-run"
            >
              启动
            </Button>
          ),
        ]}
      >
        {preview && !preview.ok && (
          <Alert
            type="error"
            showIcon
            data-testid="preflight-error"
            message={`第 ${preview.stepIndex} 步的占位符 {${preview.key}} 没有取值`}
            description={`stepIndex = ${preview.stepIndex}，key = ${preview.key}。不会发送任何消息。`}
          />
        )}
        {preview?.ok && (
          <Table
            size="small"
            rowKey="index"
            pagination={false}
            dataSource={preview.steps}
            data-testid="preflight-table"
            columns={[
              { title: '#', dataIndex: 'index', width: 40 },
              { title: '最终文本', dataIndex: 'text' },
              {
                title: '取值与来源',
                key: 'vars',
                render: (_: unknown, s) => (
                  <Space direction="vertical" size={2}>
                    {Object.entries(s.resolvedVars).map(([k, v]) => (
                      <span key={k}>
                        <Typography.Text code>{k}</Typography.Text> = {v}{' '}
                        <Tag color={s.varSources[k] === 'default' ? 'default' : 'blue'} data-testid="var-source">
                          {s.varSources[k]}
                        </Tag>
                      </span>
                    ))}
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Modal>
    </div>
  );
}

function GroupRuns({ groupId }: { groupId: string }) {
  const runs = useQuery({ queryKey: ['sequenceRuns', groupId], queryFn: () => api.groupSequenceRuns(groupId) });
  return (
    <Card title="该群最近的序列运行" style={{ marginTop: 16 }}>
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={runs.data}
        columns={[
          { title: 'run', dataIndex: 'id', render: (id: string) => <Link to={`/sequence-runs/${id}`}>{id.slice(0, 8)}</Link> },
          { title: '状态', dataIndex: 'status', render: (s: string) => <Tag color={SEQ_RUN_COLOR[s]}>{s}</Tag> },
          { title: '当前步', dataIndex: 'currentStepIndex' },
          { title: '开始', dataIndex: 'createdAt', render: fmtTime },
        ]}
      />
    </Card>
  );
}

function NewSequenceModal({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(id: string): void }) {
  const qc = useQueryClient();
  const [text, setText] = useState(JSON.stringify(EXAMPLE, null, 2));
  const [errors, setErrors] = useState<string[]>([]);
  const create = useMutation({
    mutationFn: (def: SequenceDef) => api.createSequence(def),
    onSuccess: ({ id }) => {
      void qc.invalidateQueries({ queryKey: ['sequences'] });
      onCreated(id);
    },
    onError: (err) => setErrors([errorText(err)]),
  });
  const submit = () => {
    let def: unknown;
    try {
      def = JSON.parse(text);
    } catch {
      return setErrors(['不是合法的 JSON']);
    }
    const problems = validateSequence(def);
    setErrors(problems);
    if (problems.length === 0) create.mutate(def as SequenceDef);
  };
  return (
    <Modal title="新建序列" open={open} onCancel={onClose} onOk={submit} confirmLoading={create.isPending} width={640}>
      <Input.TextArea rows={14} value={text} onChange={(e) => setText(e.target.value)} style={{ fontFamily: 'monospace' }} data-testid="sequence-json" />
      {errors.length > 0 && (
        <Alert
          type="error"
          style={{ marginTop: 12 }}
          message="定义有误"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          }
        />
      )}
    </Modal>
  );
}
