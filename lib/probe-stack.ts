import { Construct } from 'constructs';
import { Duration, RemovalPolicy, Stack, StackProps, aws_lambda as lambda, aws_logs as logs } from 'aws-cdk-lib';
import { PROBE_FUNCTION_NAME, checkerCode } from './checker-code';

// A probe in another region (Virginia, Tokyo): runs the same guest checks from there when the Ireland checker calls
// it, and returns the raw results. It has no schedule, no storage and no AWS permissions beyond its own logs.
export class ProbeStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    new lambda.Function(this, 'Probe', {
      functionName: PROBE_FUNCTION_NAME,
      description: 'Runs the status.dliu.com guest checks from this region',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.probe',
      code: checkerCode(),
      memorySize: 256,
      timeout: Duration.seconds(60),
      logGroup: new logs.LogGroup(this, 'ProbeLogs', {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
  }
}
