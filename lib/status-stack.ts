import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';
import {
  AssetHashType,
  CfnOutput,
  CfnResource,
  DockerImage,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_events as events,
  aws_events_targets as eventsTargets,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
} from 'aws-cdk-lib';

const ROOT = path.join(__dirname, '..');
const LOG_RETENTION = logs.RetentionDays.THREE_MONTHS;
export const CHECK_INTERVAL_MINUTES = 15;
export const SITE_PAGES = ['*.html', 'docs/*.html'];
export const STATIC_CACHE_CONTROL = ['public', 'max-age=300', 's-maxage=86400', 'stale-while-revalidate=86400'];
// Written by the checker every run; never deployed or pruned by the site deployments.
export const DATA_PREFIX = 'data/*';

// Extensionless docs URLs → their files in the bucket.
export const ROUTES_FUNCTION_CODE = `
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri === '/docs' || uri === '/docs/') request.uri = '/docs/index.html';
  else if (uri === '/docs/health') request.uri = '/docs/health.html';
  return request;
}
`;

export interface StatusStackProps extends StackProps {
  subdomain?: string;
  /** Attach traffic.dliu.com's visitor function and cookie logging, like the other sites (default true). */
  trafficLogging?: boolean;
}

export class StatusStack extends Stack {
  constructor(scope: Construct, id: string, props: StatusStackProps = {}) {
    super(scope, id, props);

    const subdomain = props.subdomain ?? 'status';
    const rootDomain = Fn.importValue('MainDomain');
    const domainName = Fn.join('', [`${subdomain}.`, rootDomain]);
    const siteUrl = Fn.join('', ['https://', domainName]);
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'ImportedHostedZone', {
      zoneName: rootDomain,
      hostedZoneId: Fn.importValue('MainHostedZoneId'),
    });

    // Public pages and data/status.json, served only through CloudFront.
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // The checker's memory: failure streaks, 90 days of history and incidents, including private apps.
    // Never served; kept if the stack is deleted.
    const stateBucket = new s3.Bucket(this, 'StateBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // The checker's code plus config/apps.json, copied next to it (no Docker needed).
    const checkerCode = lambda.Code.fromAsset(path.join(ROOT, 'lambda', 'checker'), {
      bundling: {
        image: DockerImage.fromRegistry('public.ecr.aws/docker/library/node:22-alpine'),
        local: {
          tryBundle(outputDir: string) {
            for (const file of fs.readdirSync(path.join(ROOT, 'lambda', 'checker'))) {
              fs.copyFileSync(path.join(ROOT, 'lambda', 'checker', file), path.join(outputDir, file));
            }
            fs.copyFileSync(path.join(ROOT, 'config', 'apps.json'), path.join(outputDir, 'apps.json'));
            return true;
          },
        },
        command: ['sh', '-c', 'cp -r /asset-input/* /asset-output/'],
      },
      // Hash the bundled output, so editing config/apps.json alone redeploys the checker.
      assetHashType: AssetHashType.OUTPUT,
    });

    const checker = new lambda.Function(this, 'Checker', {
      description: 'Tests every dliu.com site as a guest and writes data/status.json',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: checkerCode,
      memorySize: 256,
      timeout: Duration.seconds(90),
      environment: {
        SITE_BUCKET: siteBucket.bucketName,
        STATE_BUCKET: stateBucket.bucketName,
        NODE_OPTIONS: '--enable-source-maps',
      },
      logGroup: new logs.LogGroup(this, 'CheckerLogs', {
        retention: LOG_RETENTION,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    stateBucket.grantReadWrite(checker, 'state.json');
    siteBucket.grantPut(checker, DATA_PREFIX);

    new events.Rule(this, 'CheckSchedule', {
      description: `Run the status checks every ${CHECK_INTERVAL_MINUTES} minutes`,
      schedule: events.Schedule.rate(Duration.minutes(CHECK_INTERVAL_MINUTES)),
      targets: [new eventsTargets.LambdaFunction(checker, { retryAttempts: 0 })],
    });

    // CloudFront requires its certificate in us-east-1 (same pattern as the other sites).
    const certificate = new acm.DnsValidatedCertificate(this, 'SiteCertificate', {
      domainName,
      hostedZone,
      region: 'us-east-1',
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SiteHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'self'; script-src 'self'; style-src 'self' https://files.dliu.com/dliu.com/ui/; object-src 'none'",
            "img-src 'self' https://files.dliu.com/dliu.com/; connect-src 'self'",
            "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          ].join('; '),
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', override: true },
        ],
      },
    });

    const routes = new cloudfront.Function(this, 'Routes', {
      comment: 'Serve /docs and /docs/health',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(ROUTES_FUNCTION_CODE),
    });

    const functionAssociations: cloudfront.FunctionAssociation[] = [
      { eventType: cloudfront.FunctionEventType.VIEWER_REQUEST, function: routes },
    ];
    const trafficLogging = props.trafficLogging ?? true;
    const trafficGeoPolicy = trafficLogging
      ? cloudfront.OriginRequestPolicy.fromOriginRequestPolicyId(this, 'TrafficGeo', Fn.importValue('TrafficGeoOriginRequestPolicyId'))
      : undefined;
    if (trafficLogging) {
      functionAssociations.push({
        eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE,
        function: cloudfront.Function.fromFunctionAttributes(this, 'VisitorId', {
          functionArn: Fn.importValue('TrafficVisitorFunctionArn'),
          functionName: 'dliu-visitor-id',
        }),
      });
    }

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      comment: 'status.dliu.com',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // Honours each object's Cache-Control: 60 s for data/status.json, no-cache for pages.
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        originRequestPolicy: trafficGeoPolicy,
        responseHeadersPolicy: headers,
        compress: true,
        functionAssociations,
      },
      domainNames: [domainName],
      certificate,
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: Duration.minutes(5) },
      ],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });
    if (trafficLogging) {
      // TrafficMonitor delivers this distribution's access logs; IncludeCookies puts dl_vid in them.
      (distribution.node.defaultChild as cloudfront.CfnDistribution)
        .addPropertyOverride('DistributionConfig.Logging', { IncludeCookies: true });
    }

    // Scripts, styles, the logo and the Markdown docs: cached a day at the edge (each deploy invalidates).
    const siteAssets = new s3deploy.BucketDeployment(this, 'SiteContent', {
      sources: [s3deploy.Source.asset(path.join(ROOT, 'web'))],
      destinationBucket: siteBucket,
      exclude: [...SITE_PAGES, DATA_PREFIX],
      distribution,
      distributionPaths: ['/*'],
      cacheControl: STATIC_CACHE_CONTROL.map((directive) => s3deploy.CacheControl.fromString(directive)),
    });
    // HTML pages stay no-cache, so a deploy shows on the next load.
    new s3deploy.BucketDeployment(this, 'SitePages', {
      sources: [s3deploy.Source.asset(path.join(ROOT, 'web'))],
      destinationBucket: siteBucket,
      exclude: ['*', DATA_PREFIX],
      include: SITE_PAGES,
      distribution,
      distributionPaths: ['/*'],
      cacheControl: [s3deploy.CacheControl.noCache()],
    }).node.addDependency(siteAssets);

    new route53.ARecord(this, 'SiteAliasRecord', {
      recordName: subdomain,
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });
    new route53.AaaaRecord(this, 'SiteAliasIpv6Record', {
      recordName: subdomain,
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    new CfnOutput(this, 'SiteUrl', { value: siteUrl });
    new CfnOutput(this, 'CheckerFunctionName', { value: checker.functionName });
    new CfnOutput(this, 'StateBucketName', { value: stateBucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });

    this.keepHelperLogs();
  }

  // CDK's helper Lambdas would otherwise log to auto-created groups that never expire.
  private keepHelperLogs() {
    const functions = this.node.findAll().filter((c): c is CfnResource =>
      c instanceof CfnResource && c.cfnResourceType === 'AWS::Lambda::Function');
    for (const fn of functions) {
      if (fn instanceof lambda.CfnFunction && (fn.loggingConfig as lambda.CfnFunction.LoggingConfigProperty | undefined)?.logGroup) continue;
      const group = new logs.LogGroup(this, `${fn.node.path.split('/').slice(1).join('')}Logs`, {
        retention: LOG_RETENTION,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      fn.addPropertyOverride('LoggingConfig.LogGroup', group.logGroupName);
      fn.node.addDependency(group);
    }
  }
}
