FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# El PaaS inyecta PORT; 8000 es el valor por defecto para `docker run` a pelo.
ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "gunicorn -b 0.0.0.0:${PORT} -w 2 --threads 1 -t 120 app:app"]
