import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { TtConfig } from './config';

export interface ComputeStackProps extends cdk.StackProps {
  readonly cfg: TtConfig;
  readonly vpc: ec2.IVpc;
  readonly appSg: ec2.ISecurityGroup;
}

export class ComputeStack extends cdk.Stack {
  // Real ALB DNS is assigned in a later task once the ALB is created;
  // placeholder here keeps synth green and the EdgeStack wiring typed.
  public readonly albDnsName: string;

  public readonly gwRepo: ecr.Repository;
  public readonly msgsvcRepo: ecr.Repository;

  public readonly cluster: ecs.Cluster;
  public readonly execRole: iam.Role;
  public readonly taskRole: iam.Role;
  public readonly gwLogs: logs.LogGroup;
  public readonly msgsvcLogs: logs.LogGroup;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    this.albDnsName = '';  // Task 6 will replace with the real ALB DNS.

    this.gwRepo = new ecr.Repository(this, 'GatewayRepo', {
      repositoryName: 'tt-gw',
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,   // we rebuild from source; repos are disposable
      emptyOnDelete: true,
    });
    this.msgsvcRepo = new ecr.Repository(this, 'MsgsvcRepo', {
      repositoryName: 'tt-msgsvc',
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc, clusterName: 'tt-cluster', containerInsights: true,
    });

    // Execution role: used by the agent to pull images + fetch secrets + write logs.
    this.execRole = new iam.Role(this, 'TaskExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    // Let exec role read our two secrets (so `secret: Secret.fromSecretsManager(...)` works).
    props.appSg; // silence unused until services attach
    const secretArns = [
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:tinytelegram/db-*`,
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:tinytelegram/redis-*`,
    ];
    this.execRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'], resources: secretArns,
    }));

    // Task role: used by app code; add ECS Exec permissions so we can shell in for debug.
    this.taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    this.taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));

    this.gwLogs     = new logs.LogGroup(this, 'GwLogs',     { logGroupName: '/tt/gateway', retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY });
    this.msgsvcLogs = new logs.LogGroup(this, 'MsgsvcLogs', { logGroupName: '/tt/msgsvc',  retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY });
  }
}
