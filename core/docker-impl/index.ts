// core/docker-impl - the `docker@1` PROVIDER (`docker-compose-cli`):
// CONTAINER execution.
//
// The command string is handed to the CONTAINER's shell exactly once:
//
//   docker compose --project-directory <dir> [-p <proj>] [-f <file>]
//     [--env-file <env>] [--profile <p>] exec -T <service> sh -c <input>
//
// `execFile` starts the docker CLI with an argv ARRAY: the workbench host shell
// never sees the input, and `sh -c <input>` evaluates the pipes, redirections,
// quotes and globs INSIDE the container. For the plain `docker` engine the argv
// is `docker exec -i <container> sh -c <input>` or
// `docker run --rm -i [-v ...] [--network ...] [<entrypoint>] <image> sh -c <input>`
// (`-i`, never `-T`: `-T` belongs to `docker compose exec` and plain `docker
// exec -T` exits 125 before running anything).
//
// An unreachable target (daemon down, service absent, image missing) fails with
// `unreachable`: the command NEVER falls back to the host.
import {
  DOCKER,
  DOCKER_CONTRACT,
  planContainer,
  validateDockerConfig,
  type DockerConfig,
  type DockerInstance,
  type DockerResult,
  type DockerRunOptions,
  type DockerService,
  type NormalizedDockerConfig,
} from '../../definitions/docker.ts'
import {
  ServiceError,
  assertPolicyDeclared,
  provideService,
  redactArgv,
  type ServiceContext,
} from '../../definitions/support.ts'
import { runProcess } from '../../lib/process.ts'

export const name = 'docker-impl'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'docker-compose-cli'

export const contract = DOCKER_CONTRACT

/** stderr fragments that mean "the target cannot be reached" (never a host fallback). */
const UNREACHABLE = [
  'Cannot connect to the Docker daemon',
  'error during connect',
  'no such service',
  'service is not running',
  'no configuration file provided',
  'Cannot find container',
  'No such container',
  'Unable to find image',
  'manifest unknown',
  'pull access denied',
]

function isUnreachable(stderr: string | undefined): boolean {
  if (stderr === undefined) return false
  return UNREACHABLE.some((fragment) => stderr.includes(fragment))
}

/** Builds the service of this provider for a validated config. */
export function createDockerService(config: DockerConfig): DockerService {
  const normalized = validateDockerConfig(config)

  const runWith = async (
    input: string,
    options: DockerRunOptions = {},
    bound: NormalizedDockerConfig = normalized,
  ): Promise<DockerResult> => {
    const { argv, display } = planContainer(bound, input)
    const outcome = await runProcess(argv, {
      timeoutMs: options.timeoutMs ?? bound.timeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? bound.maxOutputBytes,
      ...(bound.compose === undefined ? {} : { cwd: bound.compose.project_dir }),
      stage: 'docker.run',
      details: { transport: 'container', launcher: redactArgv(argv) },
    })
    void display
    if (outcome.code !== 0 && isUnreachable(outcome.stderr)) {
      throw new ServiceError('unreachable', `container: cannot reach the target: ${outcome.stderr?.trim()}`, {
        stage: 'docker.run',
        details: { transport: 'container', engine: bound.engine, code: outcome.code },
      })
    }
    return {
      output: outcome.output,
      code: outcome.code,
      stderr: outcome.stderr,
      durationMs: outcome.durationMs,
      ...(outcome.truncated === true ? { truncated: true } : {}),
    }
  }

  const create = (raw: DockerConfig): DockerInstance => {
    const child = validateDockerConfig(raw)
    return {
      contract: DOCKER_CONTRACT,
      provider: providerId,
      run: (input, options) => runWith(input, options, child),
    }
  }

  return {
    contract: DOCKER_CONTRACT,
    provider: providerId,
    describe: () =>
      normalized.engine === 'docker-compose'
        ? `docker compose ${normalized.compose?.project_dir ?? ''} ${normalized.compose?.service ?? ''}`.trim()
        : `docker ${normalized.container ?? normalized.image ?? ''}`.trim(),
    run: runWith,
    create,
  }
}

export function apply(ctx: ServiceContext, config: DockerConfig): void {
  assertPolicyDeclared(import.meta.url, { execution: 'remote', capabilities: [DOCKER] })
  const service = createDockerService(config)
  provideService(ctx, DOCKER, service)
}

export default { name, inject: [], apply }
