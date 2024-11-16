# Tauri Update Server
This is a modern implementation of a tauri update server. It works enterly over github by using a seperate repo for all the release files.

### Get started
To get started clone the reposetory from the github packages like this: 

```bash
docker run -d --name tauri-update-server \
-p 3000:3000 \
-v /path/to/your/config.yml:/app/config.yml \
ghcr.io/0pandadev/tauri-update-server:latest
```

Change `/path/to/your/config.yml` to the path on your disk where the config.yml is stored also change the left half of the port **3001**:3000 to your liking.

### Config
Take a look at the `config.yml` file for configuration.

For the archive repo there need to be a specific strucutre for the update server to correctly understand the versions you can find a production example [here](https://github.com/0PandaDEV/qopy-archives).

```yml
# GitHub configuration
github:
  release_repo: user/repo # This should be the repo of your main project)
  archive_repo: user/repo # This is where all the updater files are stored e.g. Name-v1.0.0.msi.sig, Name-v1.0.0.msi)

# Enabled platforms for which to fetch and serve update files
enabled_platforms:
  linux: true
  windows: true
  macos_intel: true # macos intel (before 2020)
  macos_silicon: true # macos silicon (M1/M2/M3...)
```
