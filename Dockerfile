FROM public.ecr.aws/docker/library/node:20-slim

# ffmpeg viene en los repos de Debian; esta imagen (a diferencia de la de n8n)
# sí tiene apt, así que se instala normal.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
