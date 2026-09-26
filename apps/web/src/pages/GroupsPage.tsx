import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { App, Button, Card, Form, Modal, Select, Space, Table, Tag } from 'antd';
import type { GroupDto } from '@gmp/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { JobStatus } from '../components/JobStatus';
import { errorText } from '../lib/format';

const GROUP_STATUS_COLOR: Record<string, string> = { active: 'green', unreachable: 'red', left: 'default' };

export function GroupsPage() {
  const { canWrite } = useAuth();
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.groups });
  const [open, setOpen] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {jobId && <JobStatus jobId={jobId} label="建群" />}
      <Card
        title="群组"
        extra={
          canWrite && (
            <Button type="primary" onClick={() => setOpen(true)} data-testid="create-group">
              建群
            </Button>
          )
        }
      >
        <Table<GroupDto>
          rowKey="id"
          loading={groups.isLoading}
          dataSource={groups.data}
          pagination={false}
          columns={[
            { title: '群', dataIndex: 'id', render: (id: string) => <Link to={`/groups/${id}`}>{id.slice(0, 8)}</Link> },
            { title: '网关群 id', dataIndex: 'gatewayGroupId' },
            { title: '状态', dataIndex: 'status', render: (s: string) => <Tag color={GROUP_STATUS_COLOR[s]}>{s}</Tag> },
            { title: '群主', dataIndex: 'creatorAccountId' },
            { title: '成员数', key: 'members', render: (_: unknown, g: GroupDto) => g.members.length },
            {
              title: 'Agent',
              key: 'agent',
              render: (_: unknown, g: GroupDto) => (
                <Space>
                  <Tag color={g.agentEnabled ? 'blue' : 'default'}>{g.agentEnabled ? '已开启' : '关闭'}</Tag>
                  {g.activeAgentRunId && <Tag color="processing">运行中</Tag>}
                </Space>
              ),
            },
          ]}
        />
      </Card>
      {canWrite && (
        <CreateGroupModal
          open={open}
          onClose={() => setOpen(false)}
          onStarted={(id) => {
            setJobId(id);
            setOpen(false);
          }}
        />
      )}
    </Space>
  );
}

function CreateGroupModal({ open, onClose, onStarted }: { open: boolean; onClose(): void; onStarted(jobId: string): void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ creatorAccountId: string; memberAccountIds: string[] }>();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts, enabled: open });
  const online = (accounts.data ?? []).filter((a) => a.status === 'online').map((a) => ({ value: a.id, label: a.id }));
  const creator = Form.useWatch('creatorAccountId', form);
  const create = useMutation({
    mutationFn: (v: { creatorAccountId: string; memberAccountIds: string[] }) =>
      api.createGroup(v.creatorAccountId, v.memberAccountIds),
    onSuccess: ({ jobId }) => {
      form.resetFields();
      onStarted(jobId);
    },
    onError: (err) => message.error(errorText(err)),
  });

  return (
    <Modal title="建群" open={open} onCancel={onClose} onOk={() => form.submit()} confirmLoading={create.isPending} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={(v) => create.mutate(v)}>
        <Form.Item name="creatorAccountId" label="群主" rules={[{ required: true }]} extra="只能选择 online 的账号">
          <Select options={online} placeholder="选择群主账号" data-testid="creator-select" />
        </Form.Item>
        <Form.Item
          name="memberAccountIds"
          label="成员（第一个会被提升为管理员）"
          rules={[{ required: true, type: 'array', min: 1, message: '至少选择一个成员' }]}
        >
          <Select
            mode="multiple"
            options={online.filter((o) => o.value !== creator)}
            placeholder="选择成员账号"
            data-testid="members-select"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
