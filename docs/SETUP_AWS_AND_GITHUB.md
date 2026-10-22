# AWS Bedrock profile setup and GitHub publication

Run all of this on your own computer. Never paste keys into chat, commit them, or put them in `.env`
files that leave your machine.

## Part 1: AWS CLI profile for Bedrock

### 1. Install the AWS CLI v2

- macOS: `brew install awscli` (or the .pkg from https://aws.amazon.com/cli/)
- Windows: the MSI installer from https://aws.amazon.com/cli/ (then reopen PowerShell)
- Check: `aws --version` should print `aws-cli/2.x`

### 2. Create a least-privilege identity (AWS Console)

**Preferred: IAM Identity Center (short-lived credentials, nothing stored long term).**
1. Console → IAM Identity Center → enable it if prompted.
2. Permission sets → Create → Custom → paste the policy below → name it `AuraVerifyBedrock`.
3. AWS accounts → select your account → Assign users → your user → `AuraVerifyBedrock`.
4. Note the **AWS access portal URL** shown on the Identity Center dashboard.

**Alternative: IAM user with an access key** (simpler, long-lived; delete the key after the hackathon).
1. Console → IAM → Users → Create user `aura-verify-bedrock` (no console access).
2. Attach a new inline policy with the JSON below.
3. Security credentials → Create access key → "Command Line Interface (CLI)". Keep the window open for
   the next step only; don't save the key in a file or chat.

Policy (Bedrock read + invoke only):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AuraVerifyBedrock",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:ListFoundationModels",
        "bedrock:GetFoundationModel",
        "bedrock:ListInferenceProfiles",
        "bedrock:GetInferenceProfile"
      ],
      "Resource": "*"
    }
  ]
}
```

`Resource: "*"` is needed because cross-region inference profiles (model ids starting with `us.`) route to
foundation models in several regions. The Converse API is authorized by `bedrock:InvokeModel`.

### 3. Configure the profile

Identity Center:

```bash
aws configure sso --profile aura-verify
#   SSO session name: aura
#   SSO start URL:    <your AWS access portal URL>
#   SSO region:       <region where Identity Center is enabled>
#   (browser opens; approve)  pick the account and the AuraVerifyBedrock role
#   CLI default client Region: us-east-1
#   CLI default output format: json
aws sso login --profile aura-verify      # repeat when the session expires
```

IAM user:

```bash
aws configure --profile aura-verify
#   AWS Access Key ID:     (paste in your terminal only)
#   AWS Secret Access Key: (paste in your terminal only)
#   Default region name:   us-east-1
#   Default output format: json
```

The key lands in `~/.aws/credentials` (Windows: `%USERPROFILE%\.aws\credentials`), outside the repo.

### 4. Confirm the profile, region and models

```bash
aws sts get-caller-identity --profile aura-verify
aws configure get region --profile aura-verify
aws bedrock list-foundation-models --profile aura-verify --region us-east-1 \
  --by-output-modality TEXT --query "modelSummaries[?contains(modelId,'nova')].modelId"
aws bedrock list-inference-profiles --profile aura-verify --region us-east-1 \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId,'nova')].inferenceProfileId"
```

AURA's default model is `us.amazon.nova-pro-v1:0` (Amazon Nova Pro via the US cross-region profile). Pick
any id from the second list that contains `nova-pro` or `nova-lite`. Amazon models are usually available
without a request; if the console's *Model access* page lists the model as not granted, request access there.
Bedrock calls are billed to your account; the full check below makes about a dozen short calls.

### 5. Run the live AURA Bedrock check

From the repository root (after `make setup`):

```bash
cd backend
AWS_PROFILE=aura-verify .venv/bin/python scripts/bedrock_check.py --region us-east-1 \
  --model us.amazon.nova-pro-v1:0
```

Windows PowerShell:

```powershell
cd backend
$env:AWS_PROFILE="aura-verify"; .venv\Scripts\python scripts\bedrock_check.py --region us-east-1 --model us.amazon.nova-pro-v1:0
```

It calls STS, lists models, makes one Converse call, runs AURA's Bedrock planner on the demo phrases, then
runs three complete agent workflows (bedtime, thermostat failure + recovery, preference update) through the
MCP server with the Bedrock planner, and fails if AURA ever fell back to the local planner. Results go to
`backend/bedrock-check-results.json` (git-ignored; it contains your account id, so share only the
pass/fail lines and model details).

### 6. Run the app on Bedrock

```bash
AWS_PROFILE=aura-verify AWS_REGION=us-east-1 AURA_PLANNER=bedrock make serve
```

The header should read **Planner · Amazon Bedrock**, and each plan's detail line shows the model id,
latency and token counts from the real response.

## Part 2: Publish to GitHub as `aura-verify`

### Option A: from the git bundle (exact history from the build)

Download `aura-verify.bundle` from the project files, then:

```bash
git clone aura-verify.bundle aura-verify
cd aura-verify
git remote remove origin             # the bundle path was recorded as origin
git log --oneline | head             # confirm the commits are there
```

### Create the repository and push

With the GitHub CLI (`gh auth login` first if needed):

```bash
gh repo create aura-verify --public --source . --remote origin --push \
  --description "AURA Verify: a household agent that proves its actions happened (MCP, Alexa+ hackathon)"
```

Or with the website: create an **empty** public repo named `aura-verify` (no README, license or
.gitignore), then:

```bash
git remote add origin https://github.com/<your-username>/aura-verify.git
git branch -M main
git push -u origin main
```

### Check before and after pushing

```bash
git ls-files | grep -E '(^|/)\.env$|\.db$|node_modules|\.venv' || echo "clean"
git grep -nE 'AKIA[0-9A-Z]{16}|aws_secret_access_key' || echo "no keys"
```

On GitHub, confirm the **MIT License** badge appears in the repo sidebar (the rules require a visible
license), and add topics such as `mcp`, `alexa`, `aws-bedrock`, `hackathon`.

If you'd rather I push from here, connect GitHub (https://claude.ai/connect-github), tell me the repo name,
and I'll attach it and push.

Keep `aura-verify.bundle` as a backup; it contains the full history and is independent of GitHub.
