FROM node:20-alpine
WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm ci --only=production

# Copy app
COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
