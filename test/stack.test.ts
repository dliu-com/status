import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ROUTES_FUNCTION_CODE, StatusStack } from '../lib/status-stack';

const template = Template.fromStack(new StatusStack(new App(), 'Test', { env: { account: '123456789012', region: 'eu-west-1' } }));

test('the checker runs every 15 minutes on Node.js 22 with no AWS access beyond its two buckets', () => {
  template.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(15 minutes)' });
  template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.handler', Runtime: 'nodejs22.x', Timeout: 90 });
  const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
  expect(policies).not.toMatch(/cloudwatch:|dynamodb:|cloudformation:|"s3:\*"|lambda:Invoke/);
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

test('the docs routes map extensionless URLs to files', () => {
  const handler = new Function(`${ROUTES_FUNCTION_CODE}; return handler;`)();
  const route = (uri: string) => handler({ request: { uri } }).uri;
  expect(route('/docs')).toBe('/docs/index.html');
  expect(route('/docs/')).toBe('/docs/index.html');
  expect(route('/docs/health')).toBe('/docs/health.html');
  expect(route('/docs/health.md')).toBe('/docs/health.md');
  expect(route('/data/status.json')).toBe('/data/status.json');
});
