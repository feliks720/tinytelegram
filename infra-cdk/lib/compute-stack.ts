import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
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

  public readonly namespace: servicediscovery.PrivateDnsNamespace;
  public readonly msgsvcService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    const cfg = props.cfg;
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

    // Private DNS namespace for gateway -> msgsvc discovery (simpler than Service Connect).
    this.namespace = new servicediscovery.PrivateDnsNamespace(this, 'Ns', {
      vpc: props.vpc,
      name: 'tt.local',
    });

    const dbSecret    = secretsmanager.Secret.fromSecretNameV2(this, 'DbSecretImp',    'tinytelegram/db');
    const redisSecret = secretsmanager.Secret.fromSecretNameV2(this, 'RedisSecretImp', 'tinytelegram/redis');

    const msgsvcTd = new ecs.FargateTaskDefinition(this, 'MsgsvcTd', {
      cpu: cfg.taskCpu,
      memoryLimitMiB: cfg.taskMemoryMb,
      executionRole: this.execRole,
      taskRole: this.taskRole,
    });
    // The msgsvc binary reads a single POSTGRES_DSN and REDIS_AUTH, but ECS
    // secret injection can only map one secret key per env var. We inject the
    // parts as env vars and compose them into the expected names in a sh -c
    // wrapper before exec'ing the binary. Keeps the Go code unchanged.
    msgsvcTd.addContainer('msgsvc', {
      image: ecs.ContainerImage.fromEcrRepository(this.msgsvcRepo, cfg.imageTag),
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.msgsvcLogs, streamPrefix: 'msgsvc' }),
      portMappings: [{ containerPort: 5050, name: 'grpc' }],
      environment: {
        DB_HOST:    cfg.rdsEndpoint,
        DB_PORT:    '5432',
        DB_NAME:    'tinytelegram',
        REDIS_ADDR: `${cfg.redisEndpoint}:6379`,
        REDIS_TLS:  'true',
      },
      secrets: {
        DB_PASSWORD:      ecs.Secret.fromSecretsManager(dbSecret,    'password'),
        DB_USER:          ecs.Secret.fromSecretsManager(dbSecret,    'username'),
        REDIS_AUTH_TOKEN: ecs.Secret.fromSecretsManager(redisSecret, 'token'),
      },
      entryPoint: ['sh', '-c'],
      command: [
        'export POSTGRES_DSN="postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=require"; ' +
        'export REDIS_AUTH="$REDIS_AUTH_TOKEN"; ' +
        'exec ./message-service',
      ],
    });

    // AppSg has no ingress rules by default — allow self-traffic on msgsvc's gRPC port
    // so the gateway (same SG) can reach msgsvc via CloudMap DNS.
    props.appSg.connections.allowFrom(props.appSg, ec2.Port.tcp(5050), 'gateway to msgsvc grpc');

    this.msgsvcService = new ecs.FargateService(this, 'MsgsvcService', {
      cluster: this.cluster,
      taskDefinition: msgsvcTd,
      desiredCount: cfg.msgsvcDesiredCount,
      securityGroups: [props.appSg as ec2.ISecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      enableExecuteCommand: true,
      cloudMapOptions: {
        cloudMapNamespace: this.namespace,
        name: 'msgsvc',
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
      // Note: Fargate does not support PlacementStrategies. AZ spread is
      // achieved implicitly by ECS Fargate when the service scales across
      // the subnets provided in vpcSubnets (one per AZ).
    });
  }
}
