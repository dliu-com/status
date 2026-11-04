import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';
import {
  CfnOutput,
  CfnResource,
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
  aws_iam as iam,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
} from 'aws-cdk-lib';
import { LOCATIONS, Location, PROBE_FUNCTION_NAME, checkerCode } from './checker-code';

const ROOT = path.join(__dirname, '..');
const LOG_RETENTION = logs.RetentionDays.THREE_MONTHS;
export const CHECK_INTERVAL_MINUTES = 15;
export const SITE_PAGES = ['*.html', 'docs/*.html'];
export const STATIC_CACHE_CONTROL = ['public', 'max-age=300', 's-maxage=86400', 'stale-while-revalidate=86400'];
// Written by the checker every run; never deployed or pruned by the site deployments.
export const DATA_PREFIX = 'data/*';

// /docs → its file in the bucket; the old /docs/health page is now the #health tab.
export const ROUTES_FUNCTION_CODE = `
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri === '/docs/health' || uri === '/docs/health/') {
    return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: '/docs#health' } } };
  }
  if (uri === '/docs' || uri === '/docs/') request.uri = '/docs/index.html';
  return request;
}
`;

// Pages link their own scripts and styles as /<file>?v=<content hash>, so a new page never runs with a stale cached
// script (scripts are cached for 5 minutes, and browsers may keep using the old copy while they fetch the new one).
export function versionedPage(html: string, webDir: string): string {
  return html.replace(/(src|href)="\/([\w./-]+\.(?:js|css))"/g, (match, attribute, file) => {
    const full = path.join(webDir, file);
    if (!fs.existsSync(full)) return match;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 10);
    return `${attribute}="/${file}?v=${hash}"`;
  });
}

export function sitePages(webDir: string): s3deploy.ISource[] {
  const pages: s3deploy.ISource[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) {
        pages.push(s3deploy.Source.data(path.relative(webDir, full), versionedPage(fs.readFileSync(full, 'utf8'), webDir)));
      }
    }
  };
  walk(webDir);
  return pages;
}

export interface StatusStackProps extends StackProps {
  subdomain?: string;
  /** Where the checks run from (config/apps.json "locations"); the first is this stack's region. */
  locations?: Location[];
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

    const checker = new lambda.Function(this, 'Checker', {
      description: 'Tests every dliu.com site as a guest and writes data/status.json',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: checkerCode(),
      memorySize: 256,
      // Waits for the probes in the other regions too.
      timeout: Duration.seconds(120),
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
    // May call only the probes in the other locations, nothing else.
    const remote = (props.locations ?? LOCATIONS).filter((l) => l.region !== this.region);
    if (remote.length) {
      checker.addToRolePolicy(new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: remote.map((l) => `arn:aws:lambda:${l.region}:${this.account}:function:${PROBE_FUNCTION_NAME}`),
      }));
    }
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
      comment: 'Serve /docs; redirect /docs/health to /docs#health',
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
      sources: sitePages(path.join(ROOT, 'web')),
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
