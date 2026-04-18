import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { TtConfig } from './config';

export interface DataStackProps extends cdk.StackProps {
  readonly cfg: TtConfig;
  readonly vpc: ec2.IVpc;
}

export class DataStack extends cdk.Stack {
  public readonly dbSecret: secretsmanager.Secret;
  public readonly dbCluster: rds.DatabaseInstance;
  public readonly redisAuth: secretsmanager.Secret;
  public readonly redisGroup: elasticache.CfnReplicationGroup;
  public readonly dbSg: ec2.SecurityGroup;
  public readonly redisSg: ec2.SecurityGroup;
  public readonly appSg: ec2.SecurityGroup;  // exported for compute-stack to attach to Fargate tasks

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { cfg, vpc } = props;

    // -------- Secrets --------
    this.dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
      secretName: 'tinytelegram/db',
      description: 'RDS postgres master credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'tt_user' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    this.redisAuth = new secretsmanager.Secret(this, 'RedisAuthSecret', {
      secretName: 'tinytelegram/redis',
      description: 'ElastiCache Redis AUTH token',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'token',
        // ElastiCache AUTH tokens have character restrictions.
        excludeCharacters: '@"/\\\' ',
        passwordLength: 32,
      },
    });

    // Security groups wired further down after RDS + ElastiCache are built.
    // (continues in Task 8)
    this.dbSg = new ec2.SecurityGroup(this, 'DbSg',    { vpc, description: 'tt rds',         allowAllOutbound: false });
    this.redisSg = new ec2.SecurityGroup(this, 'RedisSg', { vpc, description: 'tt redis',    allowAllOutbound: false });
    this.appSg = new ec2.SecurityGroup(this, 'AppSg',   { vpc, description: 'tt app tasks', allowAllOutbound: true  });

    this.dbSg.addIngressRule(this.appSg,    ec2.Port.tcp(5432), 'app → rds');
    this.redisSg.addIngressRule(this.appSg, ec2.Port.tcp(6379), 'app → redis');

    // RDS and ElastiCache resources added in Tasks 8 and 9.
    this.dbCluster = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.of(cfg.rdsEngineVersion, cfg.rdsEngineVersion.split('.')[0]),
      }),
      instanceType: new ec2.InstanceType(cfg.rdsInstanceClass.replace('db.', '')),
      allocatedStorage: cfg.rdsAllocatedStorageGb,
      storageType: rds.StorageType.GP3,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSg],
      multiAz: true,
      credentials: rds.Credentials.fromSecret(this.dbSecret),
      databaseName: 'tinytelegram',
      backupRetention: cdk.Duration.days(7),
      deletionProtection: false, // school project; simplify teardown
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enablePerformanceInsights: true,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      monitoringInterval: cdk.Duration.seconds(1), // enhanced monitoring at 1s
      cloudwatchLogsExports: ['postgresql'],
    });

    new cdk.CfnOutput(this, 'DbEndpoint', { value: this.dbCluster.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'DbSecretArn', { value: this.dbSecret.secretArn });

    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'tt redis subnets',
      subnetIds: vpc.isolatedSubnets.map(s => s.subnetId),
    });

    this.redisGroup = new elasticache.CfnReplicationGroup(this, 'RedisGroup', {
      replicationGroupDescription: 'tinytelegram',
      engine: 'redis',
      engineVersion: cfg.cacheEngineVersion,
      cacheNodeType: cfg.cacheNodeType,
      numNodeGroups: 1,
      replicasPerNodeGroup: cfg.cacheNumReplicas,
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
      cacheSubnetGroupName: subnetGroup.ref,
      securityGroupIds: [this.redisSg.securityGroupId],
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true,
      authToken: this.redisAuth.secretValueFromJson('token').unsafeUnwrap(),
      snapshotRetentionLimit: 1,
    });
    this.redisGroup.addDependency(subnetGroup);

    new cdk.CfnOutput(this, 'RedisPrimaryEndpoint', { value: this.redisGroup.attrPrimaryEndPointAddress });
    new cdk.CfnOutput(this, 'RedisAuthSecretArn',   { value: this.redisAuth.secretArn });
  }
}
