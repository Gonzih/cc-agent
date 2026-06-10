# TODO — Fix EPIPE storm

- [x] Write PLAN.md and TODO.md
- [x] Fix uncaughtException handler in src/index.ts to exit(0) on EPIPE
- [x] Fix unhandledRejection handler to exit(0) on EPIPE
- [x] Add process.stdout.on('error') handler for EPIPE
- [ ] npm install && npm run build && npm test
- [ ] git checkout -b fix/epipe-graceful-exit
- [ ] git add + diff review + commit + push + PR + merge
- [ ] npm version patch && git push --follow-tags && npm publish --access public
