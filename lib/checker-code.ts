import * as fs from 'fs';
import * as path from 'path';
import { AssetHashType, DockerImage, aws_lambda as lambda } from 'aws-cdk-lib';

const ROOT = path.join(__dirname, '..');

// The checker's code plus config/apps.json copied next to it (no Docker needed). Shared by the Ireland checker and
// the probes in the other regions, so every location runs exactly the same checks.
export function checkerCode(): lambda.Code {
  return lambda.Code.fromAsset(path.join(ROOT, 'lambda', 'checker'), {
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
    // Hash the bundled output, so editing config/apps.json alone redeploys the code.
    assetHashType: AssetHashType.OUTPUT,
  });
}

export interface Location {
  key: string;
  name: string;
  region: string;
}

// The AWS locations (Ireland, Virginia, Tokyo). China runs through Globalping and needs no AWS resources.
export const LOCATIONS: Location[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'apps.json'), 'utf8'))
  .locations.filter((l: Partial<Location>) => l.region);
export const PROBE_FUNCTION_NAME = 'dliu-status-probe';
