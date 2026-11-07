FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY index.html manifest.webmanifest sw.js ./
COPY public ./public
COPY server ./server
EXPOSE 3000
CMD ["sh", "-c", "npm run db:migrate && npm start"]
