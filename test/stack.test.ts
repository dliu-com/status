import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as path from 'path';
import { ROUTES_FUNCTION_CODE, StatusStack, sitePages, versionedPage } from '../lib/status-stack';
import { ProbeStack } from '../lib/probe-stack';
import { LOCATIONS } from '../lib/checker-code';

const template = Template.fromStack(new StatusStack(new App(), 'Test', { env: { account: '123456789012', region: 'eu-west-1' } }));

test('the checker runs every 15 minutes on Node.js 22 with no AWS access beyond its buckets and the probes', () => {
  template.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(15 minutes)' });
  template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.handler', Runtime: 'nodejs22.x', Timeout: 120 });
  const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
  expect(policies).not.toMatch(/cloudwatch:|dynamodb:|cloudformation:|"s3:\*"|"lambda:\*"/);
  expect(policies).toContain('arn:aws:lambda:us-east-1:123456789012:function:dliu-status-probe');
  expect(policies).toContain('arn:aws:lambda:ap-northeast-1:123456789012:function:dliu-status-probe');
  expect(policies).not.toContain('arn:aws:lambda:eu-west-1:123456789012:function:dliu-status-probe');
});

test('checks run from Ireland, Virginia and Tokyo; each probe is a bare Lambda with no permissions', () => {
  expect(LOCATIONS.map((l) => l.region)).toEqual(['eu-west-1', 'us-east-1', 'ap-northeast-1']);
  const probe = Template.fromStack(new ProbeStack(new App(), 'Probe', { env: { account: '123456789012', region: 'ap-northeast-1' } }));
  probe.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'dliu-status-probe', Handler: 'index.probe', Runtime: 'nodejs22.x' });
  probe.resourceCountIs('AWS::Events::Rule', 0);
  probe.resourceCountIs('AWS::S3::Bucket', 0);
  expect(JSON.stringify(probe.findResources('AWS::IAM::Policy'))).toBe('{}');
  for (const group of Object.values(probe.findResources('AWS::Logs::LogGroup')) as any[]) expect(group.Properties.RetentionInDays).toBe(90);
});

test('both buckets are private and the state bucket is kept', () => {
  template.resourceCountIs('AWS::S3::Bucket', 2);
  template.allResourcesProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
  });
  const buckets = template.findResources('AWS::S3::Bucket');
  expect(Object.values(buckets).some((b: any) => b.DeletionPolicy === 'Retain')).toBe(true);
});

test('the site is served at status.<domain> with a strict CSP', () => {
  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({ DefaultRootObject: 'index.html', Comment: 'status.dliu.com' }),
  });
  template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
    ResponseHeadersPolicyConfig: Match.objectLike({
      SecurityHeadersConfig: Match.objectLike({
        ContentSecurityPolicy: Match.objectLike({ ContentSecurityPolicy: Match.stringLikeRegexp("script-src 'self';") }),
      }),
    }),
  });
});

test('every log group expires after 90 days', () => {
  const groups = Object.values(template.findResources('AWS::Logs::LogGroup')) as any[];
  expect(groups.length).toBeGreaterThan(0);
  for (const group of groups) expect(group.Properties.RetentionInDays).toBe(90);
});

test('the docs routes map /docs to its file and redirect the old testing page to its tab', () => {
  const handler = new Function(`${ROUTES_FUNCTION_CODE}; return handler;`)();
  const route = (uri: string) => handler({ request: { uri } }).uri;
  expect(route('/docs')).toBe('/docs/index.html');
  expect(route('/docs/')).toBe('/docs/index.html');
  expect(handler({ request: { uri: '/docs/health' } })).toEqual({ statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: '/docs#health' } } });
  expect(route('/docs/health.md')).toBe('/docs/health.md');
  expect(route('/data/status.json')).toBe('/data/status.json');
});

test('pages link their scripts and styles with a content hash, so a new page never runs a stale script', () => {
  const web = path.join(__dirname, '..', 'web');
  const page = versionedPage('<link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script><img src="/logo.svg"><a href="/docs">', web);
  expect(page).toMatch(/href="\/style\.css\?v=[0-9a-f]{10}"/);
  expect(page).toMatch(/src="\/app\.js\?v=[0-9a-f]{10}"/);
  expect(page).toContain('src="/logo.svg"');
  expect(page).toContain('href="/docs"');
  expect(sitePages(web)).toHaveLength(3);
});
