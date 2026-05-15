import { ArchitectureStage } from './models.js';
import { ServiceDefinition } from './control-plane-types.js';

export const ARCHITECTURE: ArchitectureStage[] = [
  {
    id: 'ui',
    title: 'Angular control center',
    summary: 'Operators compose runs, preview shard plans, and monitor the autoscaled worker plane in one place.',
    bullets: [
      'Run builder shows shard count, required staging identities and requested worker replicas',
      'The entered virtual user count remains operator-defined',
      'All traffic remains scoped to staging'
    ],
    tone: 'ui'
  },
  {
    id: 'control',
    title: 'Node orchestrator and planner',
    summary: 'The orchestrator leases one staging identity per virtual user, requests worker scale, then dispatches shards across the cluster.',
    bullets: [
      'Planner supports arbitrary volumes up to the configured ceiling',
      'In-cluster scale control for worker-service',
      'Shard telemetry is aggregated back into one run'
    ],
    tone: 'control'
  },
  {
    id: 'worker',
    title: 'Worker-service execution plane',
    summary: 'The generic behavior engine runs on autoscaled worker pods and binds each virtual user to its own leased staging identity within each shard.',
    bullets: [
      'Mixed HTTP and websocket behavior',
      'Private, group, media and social actions',
      'Shard-ready execution distributed across pods'
    ],
    tone: 'worker'
  },
  {
    id: 'target',
    title: 'Staging business platform',
    summary: 'Generated traffic hits the staging ingress and exposes replica, latency and pressure signals across the business platform.',
    bullets: [
      'Frontend, gateway and realtime paths',
      'Messaging, group, media and notification pressure',
      'HPA-aware view of the target services'
    ],
    tone: 'target'
  }
];

export const SERVICE_DEFINITIONS: ServiceDefinition[] = [
  { id: 'svc-front', name: 'web-frontend', focus: 'frontend', fallbackMinReplicas: 2, fallbackMaxReplicas: 8, note: 'Frontend reacts mainly to browse and navigation density.' },
  { id: 'svc-bff', name: 'bff', focus: 'gateway', fallbackMinReplicas: 2, fallbackMaxReplicas: 8, note: 'Gateway pressure follows mixed HTTP traffic and auth fan-in.' },
  { id: 'svc-ws', name: 'ws-manager', focus: 'realtime', fallbackMinReplicas: 3, fallbackMaxReplicas: 10, note: 'Realtime load rises with socket occupancy and message spikes.' },
  { id: 'svc-chat', name: 'chat-service', focus: 'chat', fallbackMinReplicas: 2, fallbackMaxReplicas: 8, note: 'Mongo persistence and message fan-out dominate here.' },
  { id: 'svc-group', name: 'group-service', focus: 'group', fallbackMinReplicas: 2, fallbackMaxReplicas: 6, note: 'Group resolution becomes visible when group intent dominates.' },
  { id: 'svc-media', name: 'media-service', focus: 'media', fallbackMinReplicas: 1, fallbackMaxReplicas: 6, note: 'Uploads are rare but produce sharp bursts toward MinIO.' },
  { id: 'svc-notif', name: 'notification-service', focus: 'notifications', fallbackMinReplicas: 2, fallbackMaxReplicas: 8, note: 'Notification fan-out reacts to message, social and group churn.' },
  { id: 'svc-user', name: 'user-service', focus: 'identity', fallbackMinReplicas: 2, fallbackMaxReplicas: 6, note: 'Friends, profiles and social graph reads keep this service warm.' }
];
