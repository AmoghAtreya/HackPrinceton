/**
 * AWS region for every Amazon service Triage calls (Transcribe, Polly, …).
 * Credentials are resolved separately by the AWS SDK's default Node chain
 * (AWS_PROFILE, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, ~/.aws, SSO), in the
 * main process only.
 */
export function awsRegionFromEnv(env: NodeJS.ProcessEnv = process.env, override?: string): string {
  return override || env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1'
}
