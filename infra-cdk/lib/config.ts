export interface TtConfig {
  // AWS target
  readonly region: string;
  readonly account: string;
  // VPC
  readonly azCount: number;            // 2
  readonly vpcCidr: string;            // e.g. '10.20.0.0/16'
  // RDS (budget-comfortable defaults per memory/feedback_budget_comfortable.md)
  readonly rdsInstanceClass: string;   // 'db.m6g.large'
  readonly rdsAllocatedStorageGb: number; // 100
  readonly rdsEngineVersion: string;   // '16.3'
  // ElastiCache (budget-comfortable defaults)
  readonly cacheNodeType: string;      // 'cache.m6g.large'
  readonly cacheNumReplicas: number;   // 1
  readonly cacheEngineVersion: string; // '7.1'
  // ECS compute
  readonly gatewayDesiredCount: number;   // 2 (one per AZ)
  readonly msgsvcDesiredCount: number;    // 1 (demo-only override)
  readonly albIdleTimeoutSec: number;     // 3600
  readonly taskCpu: number;               // 1024  (1 vCPU)
  readonly taskMemoryMb: number;          // 2048  (2 GB)
  // ECR
  readonly imageTag: string;              // 'latest'  (build-push.sh overrides per deploy)
}

// Single source of truth for environment config. Hard-coded rather than
// scattered across context/env vars so a reader can see the full shape at
// a glance. Change here to tune; re-deploy to apply.
export const ttConfig: TtConfig = {
  region: 'us-east-1',
  account: '557270420767',
  azCount: 2,
  vpcCidr: '10.20.0.0/16',
  rdsInstanceClass: 'db.m6g.large',
  rdsAllocatedStorageGb: 100,
  rdsEngineVersion: '16.3',
  cacheNodeType: 'cache.m6g.large',
  cacheNumReplicas: 1,
  cacheEngineVersion: '7.1',
  gatewayDesiredCount: 2,
  msgsvcDesiredCount: 1,
  albIdleTimeoutSec: 3600,
  taskCpu: 1024,
  taskMemoryMb: 2048,
  imageTag: 'latest',
};
