AWS_REGION ?= eu-west-1
STACK_NAME ?= Status

.PHONY: install test synth diff deploy check check-local report outputs

install:
	npm ci

test:
	npx tsc --noEmit
	npm test -- --runInBand

synth:
	AWS_REGION=$(AWS_REGION) npm run synth -- --quiet

diff:
	AWS_REGION=$(AWS_REGION) npm run diff

deploy: test
	AWS_REGION=$(AWS_REGION) npm run deploy
	@$(MAKE) --no-print-directory check

# Run the checker in AWS now (it also runs every 15 minutes) and print its one-line summary.
check:
	@fn=$$(aws cloudformation describe-stacks --region $(AWS_REGION) --stack-name $(STACK_NAME) \
		--query "Stacks[0].Outputs[?OutputKey=='CheckerFunctionName'].OutputValue" --output text) && \
	aws lambda invoke --region $(AWS_REGION) --function-name $$fn --cli-read-timeout 120 /dev/stdout --output text --query FunctionError

# Run every check from this machine without writing anything (to try config/apps.json changes).
check-local:
	node scripts/check-now.js

# Current status of every site, private ones included, from the checker's private state.
report:
	@bucket=$$(aws cloudformation describe-stacks --region $(AWS_REGION) --stack-name $(STACK_NAME) \
		--query "Stacks[0].Outputs[?OutputKey=='StateBucketName'].OutputValue" --output text) && \
	aws s3 cp s3://$$bucket/state.json - --region $(AWS_REGION) | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const st=JSON.parse(s);console.log("Last run:",st.lastRun);for(const[k,v]of Object.entries(st.current))console.log(v.status.padEnd(9),k.padEnd(10),"since",v.since)})'

outputs:
	aws cloudformation describe-stacks --region $(AWS_REGION) --stack-name $(STACK_NAME) \
		--query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
