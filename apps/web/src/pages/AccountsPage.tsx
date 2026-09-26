import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Space, Table, Tag, Typography } from 'antd';
import { canTransition, type AccountDto, type AccountStatus } from '@gmp/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { ACCOUNT_STATUS_COLOR, errorText, fmtTime } from '../lib/format';

type Action = { key: string; label: string; to: AccountStatus; run: (a: AccountDto) => Promise<unknown>; danger?: boolean };

/** Each button appears only when its transition is legal from the current status (shared table). */
const ACTIONS: Action[] = [
  { key: 'offline', label: '标记离线', to: 'disconnected', run: (a) => api.transition(a.id, 'disconnected', a.status) },
  {
    key: 'reconnect',
    label: '重连',
    to: 'online',
    // A rate-limited account is still connected; going back to online is a plain transition.
    run: (a) => (a.status === 'rate_limited' ? api.transition(a.id, 'online', a.status) : api.connect(a.id)),
  },
  { key: 'release', label: '释放账号', to: 'idle', run: (a) => api.transition(a.id, 'idle', a.status), danger: true },
];

export function AccountsPage() {
  const { canWrite } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });

  const mutation = useMutation({
    mutationFn: ({ action, account }: { action: Action; account: AccountDto }) => action.run(account),
    onSuccess: (_d, { action, account }) => message.success(`${account.id}：${action.label}成功`),
    onError: (err) => message.error(errorText(err)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  });

  return (
    <Card title="服务账号">
      <Table<AccountDto>
        rowKey="id"
        loading={accounts.isLoading}
        dataSource={accounts.data}
        pagination={false}
        columns={[
          { title: '账号', dataIndex: 'id' },
          {
            title: '状态',
            dataIndex: 'status',
            render: (s: string) => (
              <Tag color={ACCOUNT_STATUS_COLOR[s]} data-testid="account-status">
                {s}
              </Tag>
            ),
          },
          { title: 'platformUserId', dataIndex: 'platformUserId', render: (v) => v ?? '—' },
          {
            title: '限流至',
            dataIndex: 'rateLimitedUntil',
            render: (v: string | null) => (v ? <Typography.Text type="warning">{fmtTime(v)}</Typography.Text> : '—'),
          },
          ...(canWrite
            ? [
                {
                  title: '操作',
                  key: 'actions',
                  render: (_: unknown, a: AccountDto) => (
                    <Space>
                      {ACTIONS.filter((act) => canTransition(a.status, act.to)).map((act) => (
                        <Button
                          key={act.key}
                          size="small"
                          danger={act.danger}
                          loading={mutation.isPending && mutation.variables?.account.id === a.id && mutation.variables.action.key === act.key}
                          onClick={() => mutation.mutate({ action: act, account: a })}
                          data-testid={`account-${act.key}-${a.id}`}
                        >
                          {act.label}
                        </Button>
                      ))}
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />
    </Card>
  );
}
