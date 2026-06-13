import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		port: 5178,
		strictPort: true
	},
	ssr: {
		external: ['pg', 'argon2']
	}
});
