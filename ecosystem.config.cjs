// PM2 ecosystem config for birds on the shared DigitalOcean droplet.
// Port 3003 (gaylonphotos=3000, giftlist=3001, madonnahist=3002).
// See cs.md "Production Infrastructure".
//
// Reboot survival on the droplet (one-time, as root):
//   pm2 startup systemd -u root --hp /root
//   pm2 start ecosystem.config.cjs
//   pm2 save
//
// Secrets (PGPASSWORD, MIGRATION_PGPASSWORD, AUTH_SECRET, EBIRD_KEY_SECRET)
// live in /opt/birds/.env, mode 600, owned root:root. Loaded into process.env
// at boot via Node's built-in --env-file flag (Node ≥ 20.6).

module.exports = {
	apps: [
		{
			name: 'birds',
			script: 'build/index.js',
			// Cap the V8 heap well below max_memory_restart (2026-09-26): with the
			// default ceiling (~2 GB on this 4 GB droplet) V8 collects lazily and
			// RSS sailed past 600M before any GC, so PM2 restarted the app (502s).
			// Measured locally: 20 page loads + 12 searches peaked at 2.7 GB RSS
			// uncapped vs 1.0 GB with a 400 MB cap (heap held at 230-260 MB).
			node_args: '--env-file=.env --max-old-space-size=384',
			cwd: '/opt/birds',

			instances: 1,
			exec_mode: 'fork',

			autorestart: true,
			restart_delay: 5000,
			max_restarts: 10,
			min_uptime: '30s',
			// Measured 2026-09-26 with the production build and the 384 MB heap cap:
			// JavaScript data stays ~100-150 MB, but RSS plateaus at ~600-660 MB
			// (up to ~860 MB with parallel requests) because the allocator keeps
			// memory freed after large Postgres results. That is not a leak, but
			// the old 600M limit sat below it and restarted the app (502s). 1G
			// leaves room on the 4 GB droplet (other apps ~1.3 GB together).
			max_memory_restart: '1G',

			out_file: '/var/log/pm2/birds.out.log',
			error_file: '/var/log/pm2/birds.err.log',
			merge_logs: true,
			time: true,

			env: {
				NODE_ENV: 'production',
				HOST: '127.0.0.1',
				PORT: 3003,
				// glibc keeps one malloc arena per thread by default; two arenas
				// greatly reduce the freed-but-retained memory above (2026-09-26).
				// Must be in the process environment at start: .env is too late.
				MALLOC_ARENA_MAX: '2'
			}
		},
		{
			// The dedicated eBird load worker (docs/2026-08-15-ebird-worker-job-queue-plan.md).
			// Concurrency 1 is a HARD politeness rule — never cluster mode, never
			// instances > 1 (a Postgres advisory lock enforces it besides).
			name: 'birds-worker',
			script: 'build/worker.js',
			node_args: '--env-file=.env',
			cwd: '/opt/birds',

			instances: 1,
			exec_mode: 'fork',

			autorestart: true,
			restart_delay: 5000,
			max_restarts: 10,
			min_uptime: '30s',
			max_memory_restart: '300M',
			// Graceful drain must outlast one unit: 30s fetch timeout + 4s 5xx
			// retry pause + spacing + transition writes.
			kill_timeout: 45000,

			out_file: '/var/log/pm2/birds-worker.out.log',
			error_file: '/var/log/pm2/birds-worker.err.log',
			merge_logs: true,
			time: true,

			env: {
				NODE_ENV: 'production',
				BIRDS_ENV: 'production'
			}
		}
	]
};
