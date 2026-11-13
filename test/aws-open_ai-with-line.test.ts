import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as AwsOpenAiWithLine from '../lib/aws-open_ai-with-line-stack';

// NodejsFunction のバンドル（esbuild）を含むため時間がかかる
jest.setTimeout(120_000);

test('API ハンドラの Lambda がサポート中の Node.js ランタイムで作成されること', () => {
  const app = new cdk.App();
  const stack = new AwsOpenAiWithLine.AwsOpenAiWithLineStack(app, 'MyTestStack');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs22.x',
    Timeout: 29,
  });
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'messages',
    BillingMode: 'PAY_PER_REQUEST',
  });
});
