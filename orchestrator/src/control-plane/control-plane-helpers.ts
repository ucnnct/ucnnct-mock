import { BehaviorWeights, RunSummary, ServiceScaling } from '../models.js';
import {
  LeaseResponse,
  WorkerActionCounters,
  WorkerObjectiveMix
} from './control-plane-types.js';

export type AggregateDemand = {
  activeUsers: number;
  connectedUsers: number;
  requestsPerSecond: number;
  messagesPerSecond: number;
  uploadsPerMinute: number;
  groupWeight: number;
  socialWeight: number;
};

export function emptyObjectiveMix(): WorkerObjectiveMix {
  return {
    browse: 0,
    reply_messages: 0,
    socialize: 0,
    group_activity: 0,
    share_file: 0
  };
}

export function emptyActionCounters(): WorkerActionCounters {
  return {
    login: 0,
    open_home: 0,
    fetch_notifications: 0,
    fetch_friends: 0,
    open_private_conversation: 0,
    send_private_message: 0,
    open_group_conversation: 0,
    send_group_message: 0,
    create_group: 0,
    add_member: 0,
    prepare_upload: 0,
    upload_file: 0,
    open_notifications: 0,
    accept_friend_request: 0,
    logout: 0
  };
}

export function emptyBehaviorCounters(): BehaviorWeights {
  return {
    browse: 0,
    privateMessage: 0,
    group: 0,
    media: 0,
    social: 0,
    notificationCheck: 0
  };
}

export function splitVirtualUsers(totalUsers: number, shardCount: number): number[] {
  const base = Math.floor(totalUsers / shardCount);
  const remainder = totalUsers % shardCount;
  return Array.from({ length: shardCount }, (_value, index) => base + (index < remainder ? 1 : 0));
}

export function partitionAssignedUsers(
  assignedUsers: LeaseResponse['assignedUsers'],
  shardSizes: number[]
): LeaseResponse['assignedUsers'][] {
  const expectedUsers = shardSizes.reduce((sum, shardSize) => sum + shardSize, 0);
  if (assignedUsers.length !== expectedUsers) {
    throw new Error(
      `Expected ${expectedUsers} dedicated staging identities for shard dispatch, but received ${assignedUsers.length}.`
    );
  }

  const buckets: LeaseResponse['assignedUsers'][] = [];
  let cursor = 0;
  shardSizes.forEach((shardSize) => {
    buckets.push(assignedUsers.slice(cursor, cursor + shardSize));
    cursor += shardSize;
  });
  return buckets;
}

export function actionTitle(action: string): string {
  return (
    {
      login: 'User session started',
      fetch_notifications: 'Notification check',
      open_private_conversation: 'Conversation opened',
      send_private_message: 'Private message sent',
      open_group_conversation: 'Group thread opened',
      send_group_message: 'Group message sent',
      create_group: 'Group created',
      prepare_upload: 'Upload prepared',
      upload_file: 'Attachment uploaded',
      accept_friend_request: 'Friend request accepted',
      logout: 'User session closed'
    }[action] ?? 'User action'
  );
}

export function aggregateDemand(runs: RunSummary[]): AggregateDemand {
  const totalWeight = runs.reduce(
    (sum, run) =>
      sum +
      run.weights.browse +
      run.weights.privateMessage +
      run.weights.group +
      run.weights.media +
      run.weights.social +
      run.weights.notificationCheck,
    0
  );

  return {
    activeUsers: runs.reduce((sum, run) => sum + run.activeUsers, 0),
    connectedUsers: runs.reduce((sum, run) => sum + run.connectedUsers, 0),
    requestsPerSecond: runs.reduce((sum, run) => sum + run.requestsPerSecond, 0),
    messagesPerSecond: runs.reduce((sum, run) => sum + run.messagesPerSecond, 0),
    uploadsPerMinute: runs.reduce((sum, run) => sum + run.uploadsPerMinute, 0),
    groupWeight: totalWeight === 0 ? 0 : runs.reduce((sum, run) => sum + run.weights.group, 0) / totalWeight,
    socialWeight: totalWeight === 0 ? 0 : runs.reduce((sum, run) => sum + run.weights.social, 0) / totalWeight
  };
}

export function pressureFor(focus: ServiceScaling['focus'], demand: AggregateDemand): number {
  switch (focus) {
    case 'frontend': return demand.requestsPerSecond * 0.12 + demand.activeUsers * 0.03;
    case 'gateway': return demand.requestsPerSecond * 0.17 + demand.connectedUsers * 0.015;
    case 'realtime': return demand.connectedUsers * 0.08 + demand.messagesPerSecond * 4.2;
    case 'chat': return demand.messagesPerSecond * 7.4 + demand.activeUsers * 0.02;
    case 'group': return demand.groupWeight * demand.activeUsers * 0.05 + demand.messagesPerSecond * 3.2;
    case 'media': return demand.uploadsPerMinute * 14 + demand.requestsPerSecond * 0.03;
    case 'notifications': return demand.messagesPerSecond * 4.8 + demand.socialWeight * demand.activeUsers * 0.03;
    case 'identity': return demand.socialWeight * demand.activeUsers * 0.035 + demand.requestsPerSecond * 0.025;
  }
}

export function pickTopServices(weights: BehaviorWeights): string[] {
  return [
    { name: 'ws-manager', value: weights.privateMessage + weights.group },
    { name: 'chat-service', value: weights.privateMessage + weights.group + weights.media / 2 },
    { name: 'media-service', value: weights.media },
    { name: 'notification-service', value: weights.notificationCheck + weights.social },
    { name: 'user-service', value: weights.social + weights.browse / 2 }
  ].sort((left, right) => right.value - left.value).slice(0, 3).map((entry) => entry.name);
}
