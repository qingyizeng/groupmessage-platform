import { useQuery } from '@tanstack/react-query';
import { Alert, Spin } from 'antd';
import { api } from '../api/client';

/** Live status of a create-group / leave-all job (refreshed by job_changed events, with a slow poll as backup). */
export function JobStatus({ jobId, label }: { jobId: string; label: string }) {
  const job = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.job(jobId),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });
  const j = job.data;
  if (!j || j.status === 'running') {
    return <Alert type="info" showIcon icon={<Spin size="small" />} message={`${label}进行中…`} />;
  }
  if (j.status === 'finished') return <Alert type="success" showIcon message={`${label}完成`} />;
  return (
    <Alert
      type="error"
      showIcon
      message={`${label}失败`}
      description={
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {j.errors.map((e) => (
            <li key={e.step}>
              {e.step}：{e.code}
            </li>
          ))}
        </ul>
      }
    />
  );
}
