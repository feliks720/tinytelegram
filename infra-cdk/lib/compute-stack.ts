import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
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
  readonly redisSg: ec2.ISecurityGroup;
}

export class ComputeStack extends cdk.Stack {
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

  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly gwService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    const cfg = props.cfg;

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

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: props.vpc, description: 'Public ingress for ALB', allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'http from internet');

    // Gateway sits in its own SG (in ComputeStack) so that the ALB auto-
    // ingress rule from attachToApplicationTargetGroup, which references
    // albSg (also in ComputeStack), does not try to attach to appSg (in
    // DataStack) and pull DataStack -> ComputeStack, creating a cycle.
    const gwSg = new ec2.SecurityGroup(this, 'GwSg', {
      vpc: props.vpc, description: 'Gateway tasks SG', allowAllOutbound: true,
    });
    gwSg.connections.allowFrom(gwSg, ec2.Port.tcp(9000), 'gateway peer grpc');
    // Let msgsvc (in appSg/DataStack) accept gRPC from gateway (gwSg/ComputeStack).
    // Declared in ComputeStack so the rule carries the cross-stack ref in the
    // right direction.
    new ec2.CfnSecurityGroupIngress(this, 'AppSgFromGw5050', {
      groupId: props.appSg.securityGroupId,
      sourceSecurityGroupId: gwSg.securityGroupId,
      ipProtocol: 'tcp', fromPort: 5050, toPort: 5050,
      description: 'gateway to msgsvc grpc',
    });
    // Let gateway (gwSg/ComputeStack) reach Redis (redisSg/DataStack).
    new ec2.CfnSecurityGroupIngress(this, 'RedisSgFromGw6379', {
      groupId: props.redisSg.securityGroupId,
      sourceSecurityGroupId: gwSg.securityGroupId,
      ipProtocol: 'tcp', fromPort: 6379, toPort: 6379,
      description: 'gateway to redis',
    });

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc, internetFacing: true, securityGroup: albSg,
      idleTimeout: cdk.Duration.seconds(cfg.albIdleTimeoutSec),
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    this.albDnsName = this.alb.loadBalancerDnsName;
    new cdk.CfnOutput(this, 'AlbDnsName', { value: this.albDnsName });

    const gwTd = new ecs.FargateTaskDefinition(this, 'GwTd', {
      cpu: cfg.taskCpu, memoryLimitMiB: cfg.taskMemoryMb,
      executionRole: this.execRole, taskRole: this.taskRole,
    });
    // Gateway reads REDIS_AUTH directly, so we can name the injected secret
    // env var REDIS_AUTH (no wrapper needed like msgsvc).
    gwTd.addContainer('gateway', {
      image: ecs.ContainerImage.fromEcrRepository(this.gwRepo, cfg.imageTag),
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.gwLogs, streamPrefix: 'gw' }),
      portMappings: [
        { containerPort: 8080, name: 'http' },
        { containerPort: 9000, name: 'grpc' },
      ],
      environment: {
        PORT:             '8080',
        GRPC_PORT:        '9000',
        MSG_SERVICE_ADDR: 'msgsvc.tt.local:5050',
        REDIS_ADDR:       `${cfg.redisEndpoint}:6379`,
        REDIS_TLS:        'true',
      },
      secrets: {
        REDIS_AUTH: ecs.Secret.fromSecretsManager(redisSecret, 'token'),
      },
    });

    this.gwService = new ecs.FargateService(this, 'GwService', {
      cluster: this.cluster,
      taskDefinition: gwTd,
      desiredCount: cfg.gatewayDesiredCount,
      securityGroups: [gwSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      enableExecuteCommand: true,
    });

    const gwTg = new elbv2.ApplicationTargetGroup(this, 'GwTg', {
      vpc: props.vpc, port: 8080, protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health', interval: cdk.Duration.seconds(10), timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2, unhealthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(10),
    });
    this.gwService.attachToApplicationTargetGroup(gwTg);

    this.alb.addListener('HttpListener', {
      port: 80, protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [gwTg],
    });
  }
}
