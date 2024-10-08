FROM oven/bun:latest

WORKDIR /app

COPY package.json ./

RUN bun install && \
  bun add -d typescript

COPY . .
RUN rm -rf ./cache

RUN bunx tsc

EXPOSE 3000

CMD ["bun", "start"]

VOLUME /app