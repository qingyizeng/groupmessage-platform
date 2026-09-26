import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, Badge, Button, ConfigProvider, Layout, Menu, Space, Spin, Tag, Typography } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { RealtimeProvider, useRealtime } from './realtime/RealtimeProvider';
import { LoginPage } from './pages/LoginPage';
import { AccountsPage } from './pages/AccountsPage';
import { GroupsPage } from './pages/GroupsPage';
import { GroupDetailPage } from './pages/GroupDetailPage';
import { AgentRunPage } from './pages/AgentRunPage';
import { SequencesPage } from './pages/SequencesPage';
import { SequenceRunPage } from './pages/SequenceRunPage';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
});

export function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <RealtimeProvider>
              <BrowserRouter>
                <Routes>
                  <Route path="/login" element={<LoginPage />} />
                  <Route element={<RequireAuth />}>
                    <Route element={<Shell />}>
                      <Route path="/accounts" element={<AccountsPage />} />
                      <Route path="/groups" element={<GroupsPage />} />
                      <Route path="/groups/:id" element={<GroupDetailPage />} />
                      <Route path="/agent-runs/:id" element={<AgentRunPage />} />
                      <Route path="/sequences" element={<SequencesPage />} />
                      <Route path="/sequence-runs/:id" element={<SequenceRunPage />} />
                      <Route path="*" element={<Navigate to="/accounts" replace />} />
                    </Route>
                  </Route>
                </Routes>
              </BrowserRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  );
}

function RequireAuth() {
  const { user, restoring } = useAuth();
  const location = useLocation();
  if (restoring) return <Spin style={{ display: 'block', marginTop: 120 }} />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

const CONNECTION: Record<string, { status: 'success' | 'processing' | 'error'; text: string }> = {
  open: { status: 'success', text: '实时已连接' },
  connecting: { status: 'processing', text: '连接中' },
  closed: { status: 'error', text: '实时已断开' },
};

function Shell() {
  const { user, logout } = useAuth();
  const { state } = useRealtime();
  const navigate = useNavigate();
  const location = useLocation();
  const selected = location.pathname.startsWith('/sequence')
    ? 'sequences'
    : location.pathname.startsWith('/groups') || location.pathname.startsWith('/agent-runs')
      ? 'groups'
      : 'accounts';
  const conn = CONNECTION[state]!;

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <Typography.Text strong style={{ color: '#fff', whiteSpace: 'nowrap' }}>
          群组消息平台
        </Typography.Text>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[selected]}
          style={{ flex: 1 }}
          items={[
            { key: 'accounts', label: '账号', onClick: () => navigate('/accounts') },
            { key: 'groups', label: '群组', onClick: () => navigate('/groups') },
            { key: 'sequences', label: '序列', onClick: () => navigate('/sequences') },
          ]}
        />
        <Space>
          <Badge status={conn.status} text={<span style={{ color: '#fff' }}>{conn.text}</span>} />
          <Tag color={user?.role === 'admin' ? 'gold' : 'default'} data-testid="current-role">
            {user?.username}（{user?.role === 'admin' ? '管理员' : '只读'}）
          </Tag>
          <Button size="small" onClick={() => void logout().then(() => navigate('/login'))}>
            退出
          </Button>
        </Space>
      </Layout.Header>
      <Layout.Content style={{ padding: 24 }}>
        <Outlet />
      </Layout.Content>
    </Layout>
  );
}
