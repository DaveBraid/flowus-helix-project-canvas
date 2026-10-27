FROM python@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 FASTMCP_CHECK_FOR_UPDATES=off
WORKDIR /app
COPY requirements.lock /app/requirements.lock
RUN python -m pip install --no-cache-dir -r requirements.lock
COPY common.py frontend_auth.py register_frontend.py bridge.py gateway.py /app/
USER 1000:1000
CMD ["python", "gateway.py"]
