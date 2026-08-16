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
			node_args: '--env-file=.env',
			cwd: '/opt/birds',

			instances: 1,
			exec_mode: 'fork',

			autorestart: true,
			restart_delay: 5000,
			max_restarts: 10,
			min_uptime: '30s',
			// No image processing in this app — keep the footprint modest (cs.md).
			max_memory_restart: '600M',

			out_file: '/var/log/pm2/birds.out.log',
			error_file: '/var/log/pm2/birds.err.log',
			merge_logs: true,
			time: true,

			env: {
				NODE_ENV: 'production',
				HOST: '127.0.0.1',
				PORT: 3003
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
