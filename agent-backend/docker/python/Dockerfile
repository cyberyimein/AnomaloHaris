FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg

RUN pip install --no-cache-dir \
    matplotlib \
    numpy \
    pandas \
    scipy \
    sympy

WORKDIR /workspace

