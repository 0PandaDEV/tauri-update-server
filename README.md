# Tauri Update Server
This is a modern implementation of a tauri update server. It works enterly over github by using a seperate repo for all the release files.

### Get started
To get started click the green button to create a new reposetory with this one as a template

<a href="https://github.com/new?template_name=tauri-update-server&template_owner=0PandaDEV">
  <img src="https://github.com/user-attachments/assets/c63cbd4c-9152-4b6f-9edc-15e78beb4c66" alt="Streamshare Download Page">
</a>

### Config
Take a look at the `config.yml` file for configuration.

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

port: 3000 # server port
```
