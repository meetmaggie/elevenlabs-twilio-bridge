# Pin Node 20 so builds always use the right version
FROM node:20-alpine

WORKDIR /app

# Install dependencies (production only)
COPY package*.json ./
RUN npm ci --only=production

# Copy app source
COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
