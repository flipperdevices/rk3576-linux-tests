#!/usr/bin/env python3

import sys
import os
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from datetime import datetime
import json

def read_system_info(info_file):
    """Read and parse system information file."""
    system_info = {
        'board_model': 'Unknown',
        'hostname': 'Unknown', 
        'kernel_version': 'Unknown',
        'linux_distro': 'Unknown',
        'thermal_governor': [],
        'test_name': ''
    }
    
    if not os.path.exists(info_file):
        return system_info
    
    with open(info_file, 'r') as f:
        lines = f.readlines()
    
    current_section = None
    for line in lines:
        line = line.strip()
        
        if 'Board Model:' in line:
            system_info['board_model'] = line.split('Board Model:', 1)[1].strip()
        elif 'Hostname:' in line:
            system_info['hostname'] = line.split('Hostname:', 1)[1].strip()
        elif 'Full Kernel Info:' in line:
            system_info['kernel_version'] = line.split('Full Kernel Info:', 1)[1].strip()
        elif 'Test Name:' in line:
            system_info['test_name'] = line.split('Test Name:', 1)[1].strip()
        elif line.startswith('thermal_zone') and ':' in line:
            system_info['thermal_governor'].append(line)
        elif '=== Linux Distribution ===' in line:
            current_section = 'distro'
        elif current_section == 'distro' and line and not line.startswith('==='):
            if 'Description:' in line:
                system_info['linux_distro'] = line.split('Description:', 1)[1].strip()
            elif 'PRETTY_NAME=' in line:
                system_info['linux_distro'] = line.split('PRETTY_NAME=', 1)[1].strip('"')
    
    return system_info

def generate_gpu_graph(csv_file):
    """Generate GPU performance graph from GPU data."""
    try:
        # Read GPU CSV data
        df = pd.read_csv(csv_file)
        
        if df.empty or 'gpu_load' not in df.columns:
            return None, 0
        
        # Create GPU load trace with frequency in hover
        gpu_hover = []
        for _, row in df.iterrows():
            text = f"<b>GPU Load: {row['gpu_load']:.0f}%</b><br>"
            text += f"Time: {row['seconds']:.1f}s<br>"
            if 'gpu_freq' in df.columns and pd.notna(row['gpu_freq']):
                text += f"GPU Frequency: {row['gpu_freq']:.0f} MHz<br>"
            gpu_hover.append(text)
        
        trace = go.Scatter(
            x=df['seconds'],
            y=df['gpu_load'],
            mode='lines',
            name='GPU Load (%)',
            line=dict(color='#FF9800', width=2),
            hovertemplate='%{text}<extra></extra>',
            text=gpu_hover
        )
        
        # Calculate test duration
        duration = df['seconds'].iloc[-1] / 60 if len(df) > 0 else 1
        
        return trace, duration
        
    except Exception as e:
        print(f"Error processing GPU data: {e}")
        return None, 0

def generate_temperature_graph(csv_file):
    """Generate temperature graph for backward compatibility."""
    if not os.path.exists(csv_file):
        return None, None
    
    try:
        df = pd.read_csv(csv_file, comment='#')
        if df.empty:
            return None, None
        
        if 'seconds' in df.columns:
            df['time'] = df['seconds']
            time_column = 'time'
        else:
            return None, None
        
        temp_columns = [col for col in df.columns if col not in ['seconds', 'time']]
        if not temp_columns:
            return None, None
        
        for col in temp_columns:
            df[col] = pd.to_numeric(df[col], errors='coerce')
        
        df['avg_temp'] = df[temp_columns].mean(axis=1)
        
        trace = go.Scatter(
            x=df[time_column],
            y=df['avg_temp'],
            mode='lines',
            name='Temperature (°C)',
            line=dict(color='#FF6B6B', width=2)
        )
        
        duration = df[time_column].iloc[-1] / 60
        return trace, max(0.1, duration)
        
    except Exception as e:
        return None, None

def generate_system_graphs(csv_file):
    """Generate system monitoring graphs with temperature, CPU load, and CPU frequency."""
    
    if not os.path.exists(csv_file):
        return [], None
    
    try:
        # Read CSV, skipping metadata line if present
        with open(csv_file, 'r') as f:
            first_line = f.readline()
            metadata = {}
            if first_line.startswith('# METADATA:'):
                import json
                metadata_str = first_line.replace('# METADATA:', '').strip()
                metadata = json.loads(metadata_str)
        
        # Read the actual data
        df = pd.read_csv(csv_file, comment='#')
        
        if df.empty:
            return [], None
        
        # Use seconds column for time axis
        if 'seconds' in df.columns:
            df['time'] = df['seconds']
            time_column = 'time'
        else:
            return [], None
        
        traces = []
        
        # 1. Temperature trace (average with hover details)
        temp_columns = [col for col in df.columns if col.startswith('temp_')]
        if temp_columns:
            # Convert to numeric
            for col in temp_columns:
                df[col] = pd.to_numeric(df[col], errors='coerce')
            
            # Calculate average
            df['avg_temp'] = df[temp_columns].mean(axis=1)
            
            # Create hover text
            temp_hover = []
            for idx, row in df.iterrows():
                text = f"<b>Avg Temperature: {row['avg_temp']:.1f}°C</b><br>"
                text += f"Time: {row[time_column]:.1f}s<br>"
                text += "<br><b>Sensors:</b><br>"
                for col in temp_columns:
                    sensor_name = col.replace('temp_', '').replace('_', ' ').title()
                    if pd.notna(row[col]):
                        text += f"{sensor_name}: {row[col]:.1f}°C<br>"
                temp_hover.append(text)
            
            traces.append(go.Scatter(
                x=df[time_column],
                y=df['avg_temp'],
                mode='lines',
                name='Temperature (°C)',
                line=dict(color='#FF6B6B', width=2),
                hovertemplate='%{text}<extra></extra>',
                text=temp_hover,
                visible=True,
                yaxis='y'
            ))
        
        # 2. CPU Load trace (average with hover details)
        load_columns = [col for col in df.columns if col.startswith('load_')]
        if load_columns:
            # Convert to numeric
            for col in load_columns:
                df[col] = pd.to_numeric(df[col], errors='coerce')
            
            # Calculate average
            df['avg_load'] = df[load_columns].mean(axis=1)
            
            # Create hover text
            load_hover = []
            for idx, row in df.iterrows():
                text = f"<b>Avg CPU Load: {row['avg_load']:.1f}%</b><br>"
                text += f"Time: {row[time_column]:.1f}s<br>"
                text += "<br><b>Per Core:</b><br>"
                for col in sorted(load_columns):
                    core_num = col.replace('load_cpu', '')
                    if pd.notna(row[col]):
                        text += f"Core {core_num}: {row[col]:.0f}%<br>"
                load_hover.append(text)
            
            traces.append(go.Scatter(
                x=df[time_column],
                y=df['avg_load'],
                mode='lines',
                name='CPU Load (%)',
                line=dict(color='#4ECDC4', width=2),
                hovertemplate='%{text}<extra></extra>',
                text=load_hover,
                visible=True,
                yaxis='y2'
            ))
        
        # 3. CPU Frequency trace (average with hover details)
        freq_columns = [col for col in df.columns if col.startswith('freq_')]
        if freq_columns:
            # Convert to numeric
            for col in freq_columns:
                df[col] = pd.to_numeric(df[col], errors='coerce')
            
            # Calculate average
            df['avg_freq'] = df[freq_columns].mean(axis=1)
            
            # Create hover text
            freq_hover = []
            for idx, row in df.iterrows():
                text = f"<b>Avg CPU Freq: {row['avg_freq']:.0f} MHz</b><br>"
                text += f"Time: {row[time_column]:.1f}s<br>"
                text += "<br><b>Per Core:</b><br>"
                for i, col in enumerate(sorted(freq_columns)):
                    core_num = col.replace('freq_cpu', '')
                    if pd.notna(row[col]):
                        core_type = "LITTLE" if int(core_num) < 4 else "BIG"
                        text += f"Core {core_num} ({core_type}): {row[col]:.0f} MHz<br>"
                freq_hover.append(text)
            
            traces.append(go.Scatter(
                x=df[time_column],
                y=df['avg_freq'],
                mode='lines',
                name='CPU Frequency (MHz)',
                line=dict(color='#95E77E', width=2),
                hovertemplate='%{text}<extra></extra>',
                text=freq_hover,
                visible=True,
                yaxis='y3'
            ))
        
        
        # Calculate test duration
        duration = df[time_column].iloc[-1] / 60  # Convert seconds to minutes
        
        return traces, max(0.1, duration)
        
    except Exception as e:
        print(f"Error processing system data: {e}")
        import traceback
        traceback.print_exc()
        return [], None

def generate_combined_report(results_dir):
    """Generate a combined HTML report for all tests."""
    
    # Read system information
    system_info = read_system_info(os.path.join(results_dir, 'system_info.txt'))
    
    # Check for CPU stress test marker
    cpu_stress_status = None
    cpu_stress_log_content = ""
    cpu_stress_marker_file = os.path.join(results_dir, 'cpu_stress_marker.txt')
    if os.path.exists(cpu_stress_marker_file):
        with open(cpu_stress_marker_file, 'r') as f:
            marker_content = f.read()
            if 'STATUS=FAILED' in marker_content:
                cpu_stress_status = 'failed'
            elif 'CPU_STRESS=RUNNING' in marker_content or 'PID=' in marker_content:
                cpu_stress_status = 'success'
    
    # Read CPU stress log content
    cpu_stress_log_file = os.path.join(results_dir, 'cpu_stress.log')
    if os.path.exists(cpu_stress_log_file):
        with open(cpu_stress_log_file, 'r') as f:
            import html
            cpu_stress_log_content = html.escape(f.read())
    
    # Check for GPU stress test marker and read log
    gpu_stress_status = None
    gpu_stress_log_content = ""
    gpu_info_content = ""
    gpu_stress_marker_file = os.path.join(results_dir, 'gpu_stress_marker.txt')
    if os.path.exists(gpu_stress_marker_file):
        with open(gpu_stress_marker_file, 'r') as f:
            marker_content = f.read()
            if 'STATUS=FAILED' in marker_content:
                gpu_stress_status = 'failed'
            elif 'GPU_STRESS=RUNNING' in marker_content or 'PID=' in marker_content:
                gpu_stress_status = 'success'
    
    # Read GPU stress log content
    gpu_stress_log_file = os.path.join(results_dir, 'gpu_stress.log')
    if os.path.exists(gpu_stress_log_file):
        with open(gpu_stress_log_file, 'r') as f:
            import html
            full_log = f.read()
            gpu_stress_log_content = html.escape(full_log)
            
            # Extract GPU info from glmark2 header
            if 'OpenGL Information' in full_log:
                lines = full_log.split('\n')
                in_header = False
                gpu_info_lines = []
                for line in lines:
                    if 'OpenGL Information' in line:
                        in_header = True
                        continue
                    elif in_header and line.strip().startswith('Surface Size:'):
                        gpu_info_lines.append(line.strip())
                        break
                    elif in_header and (line.strip().startswith('GL_') or line.strip().startswith('Surface')):
                        gpu_info_lines.append(line.strip())
                gpu_info_content = html.escape('\n'.join(gpu_info_lines))
    
    # Read full system info for debug section
    system_info_text = ""
    system_info_file = os.path.join(results_dir, 'system_info.txt')
    if os.path.exists(system_info_file):
        with open(system_info_file, 'r') as f:
            import html
            system_info_text = html.escape(f.read())
    
    # Try new system data format first, fall back to old temperature format
    traces = []
    test_duration = None
    
    # Check for new system_data.csv
    if os.path.exists(os.path.join(results_dir, 'system_data.csv')):
        traces, test_duration = generate_system_graphs(os.path.join(results_dir, 'system_data.csv'))
    # Fall back to old temperature_data.csv
    elif os.path.exists(os.path.join(results_dir, 'temperature_data.csv')):
        # Use old temperature-only graph for backward compatibility
        temp_trace, test_duration = generate_temperature_graph(os.path.join(results_dir, 'temperature_data.csv'))
        if temp_trace:
            traces = [temp_trace]
    
    # Generate separate GPU graph if available
    gpu_graph_html = ""
    if os.path.exists(os.path.join(results_dir, 'gpu_data.csv')):
        gpu_trace, gpu_duration = generate_gpu_graph(os.path.join(results_dir, 'gpu_data.csv'))
        if gpu_trace:
            # Create separate GPU figure
            gpu_fig = go.Figure()
            gpu_fig.add_trace(gpu_trace)
            gpu_fig.update_layout(
                title={
                    'text': 'GPU Performance',
                    'x': 0.5,
                    'xanchor': 'center',
                    'font': {'size': 18, 'family': 'Arial, sans-serif'}
                },
                xaxis=dict(title="Time (seconds)"),
                yaxis=dict(
                    title="GPU Load (%)",
                    range=[0, 100],
                    titlefont=dict(color="#FF9800"),
                    tickfont=dict(color="#FF9800")
                ),
                height=400,
                margin=dict(l=60, r=60, t=60, b=60),
                plot_bgcolor='#f8f9fa',
                paper_bgcolor='white',
                hovermode='x'
            )
            gpu_graph_html = gpu_fig.to_html(include_plotlyjs=False).replace('<div>', '<div id="gpuChart">', 1)
    
    # Create figure with multiple y-axes
    fig = go.Figure()
    
    for trace in traces:
        fig.add_trace(trace)
    
    # Update layout with multiple y-axes
    fig.update_layout(
        title={
            'text': 'System Monitoring',
            'x': 0.5,
            'xanchor': 'center',
            'font': {'size': 20, 'family': 'Arial, sans-serif'}
        },
        xaxis=dict(
            title="Time (seconds)"
        ),
        yaxis=dict(
            title="Temperature (°C)",
            titlefont=dict(color="#FF6B6B"),
            tickfont=dict(color="#FF6B6B"),
            side='left'
        ),
        yaxis2=dict(
            titlefont=dict(color="#4ECDC4"),
            tickfont=dict(color="#4ECDC4"),
            anchor="x",
            overlaying="y",
            side="right",
            range=[0, 100],  # Fixed scale 0-100%
            showticklabels=False,  # Hide tick labels
            showgrid=False,  # Also hide grid for cleaner look
            title=None  # Remove title to save space
        ),
        yaxis3=dict(
            titlefont=dict(color="#95E77E"),
            tickfont=dict(color="#95E77E"),
            anchor="x",
            overlaying="y",
            side="right",
            showticklabels=False,  # Hide tick labels
            showgrid=False,  # Also hide grid for cleaner look
            title=None  # Remove title to save space
        ),
        hovermode='x',
        height=520,
        showlegend=True,
        legend=dict(
            orientation="h",
            yanchor="bottom",
            y=-0.15,
            xanchor="center",
            x=0.5
        ),
        margin=dict(l=60, r=60, t=60, b=100),
        plot_bgcolor='#f8f9fa',
        paper_bgcolor='white',
    )
    
    # Update axes with range selector
    fig.update_xaxes(
        showgrid=True,
        gridwidth=1,
        gridcolor='#e0e0e0',
        rangeslider_visible=True,
        rangeselector=dict(
            buttons=list([
                dict(count=1, label="1m", step="minute", stepmode="backward"),
                dict(count=5, label="5m", step="minute", stepmode="backward"),
                dict(count=30, label="30m", step="minute", stepmode="backward"),
                dict(count=1, label="1h", step="hour", stepmode="backward"),
                dict(step="all", label="All")
            ])
        )
    )
    
    fig.update_yaxes(
        showgrid=True,
        gridwidth=1,
        gridcolor='#e0e0e0'
    )
    
    # Format test duration
    if test_duration:
        duration_str = f"{test_duration:.1f}"
    else:
        duration_str = "0.0"
    
    # Create HTML content
    html_content = f"""
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{system_info['board_model']} Test Report</title>
    <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
    <style>
        body {{
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 0;
            padding: 20px;
            background: black;
            min-height: 100vh;
        }}
        .container {{
            max-width: 1400px;
            margin: 0 auto;
            background: white;
            border-radius: 15px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
        }}
        .header {{
            background: #EF8933;
            color: black;
            padding: 30px;
            text-align: center;
        }}
        .header h1 {{
            margin: 0 0 20px 0;
            font-size: 2.5em;
            font-weight: 300;
        }}
        .system-info {{
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            padding: 15px;
            margin: 20px auto;
            max-width: 800px;
        }}
        .system-info-item {{
            margin: 8px 0;
            font-size: 0.95em;
            line-height: 1.4;
        }}
        .system-info-label {{
            font-weight: 600;
            display: inline-block;
            min-width: 120px;
        }}
        .metadata {{
            display: flex;
            justify-content: center;
            gap: 40px;
            margin-top: 20px;
            flex-wrap: wrap;
        }}
        .metadata-item {{
            text-align: center;
        }}
        .metadata-value {{
            font-size: 2em;
            font-weight: bold;
            display: block;
        }}
        .metadata-label {{
            font-size: 0.9em;
            opacity: 0.9;
            margin-top: 5px;
        }}
        .content {{
            padding: 30px;
        }}
        .test-section {{
            margin-bottom: 40px;
        }}
        .test-title {{
            font-size: 1.5em;
            color: #333;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 2px solid #667eea;
        }}
        .chart-container {{
            margin-bottom: 40px;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 10px;
        }}
        .footer {{
            text-align: center;
            padding: 20px;
            color: #666;
            font-size: 0.9em;
            border-top: 1px solid #e0e0e0;
        }}
        .metric-controls {{
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
        }}
        .control-btn {{
            padding: 8px 16px;
            border: 2px solid #e0e0e0;
            background: white;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.9em;
            transition: all 0.3s ease;
            font-family: inherit;
        }}
        .control-btn:hover {{
            background: #f0f0f0;
            transform: translateY(-1px);
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }}
        .control-btn:active {{
            transform: translateY(0);
        }}
        .temp-btn {{
            border-color: #FF6B6B;
            color: #FF6B6B;
        }}
        .temp-btn:hover {{
            background: #FFF5F5;
        }}
        .temp-btn.active {{
            background: #FF6B6B;
            color: white;
        }}
        .load-btn {{
            border-color: #4ECDC4;
            color: #4ECDC4;
        }}
        .load-btn:hover {{
            background: #F0FFFD;
        }}
        .load-btn.active {{
            background: #4ECDC4;
            color: white;
        }}
        .freq-btn {{
            border-color: #95E77E;
            color: #95E77E;
        }}
        .freq-btn:hover {{
            background: #F5FFF3;
        }}
        .freq-btn.active {{
            background: #95E77E;
            color: white;
        }}
        .placeholder {{
            padding: 40px;
            text-align: center;
            background: #f8f9fa;
            border-radius: 10px;
            color: #999;
            font-style: italic;
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 {system_info['board_model']} Test Report</h1>
            {f'<h2 style="color: #666; margin-top: -10px; margin-bottom: 20px; font-weight: normal;">{system_info["test_name"]}</h2>' if system_info.get('test_name') else ''}
            
            <div class="system-info">
                <div class="system-info-item">
                    <span class="system-info-label">Hostname:</span>
                    {system_info['hostname']}
                </div>
                <div class="system-info-item">
                    <span class="system-info-label">Kernel:</span>
                    {system_info['kernel_version']}
                </div>
                <div class="system-info-item">
                    <span class="system-info-label">Distribution:</span>
                    {system_info['linux_distro']}
                </div>
            </div>
            
            <div class="metadata">
                <div class="metadata-item">
                    <span class="metadata-value">{duration_str}</span>
                    <span class="metadata-label">Minutes</span>
                </div>
                <div class="metadata-item">
                    <span class="metadata-value">{datetime.now().strftime('%Y-%m-%d')}</span>
                    <span class="metadata-label">Test Date</span>
                </div>
            </div>
        </div>
        
        <div class="content">
            <!-- System Monitoring Section -->
            <div class="test-section">
                <h2 class="test-title">📊 System Monitoring</h2>
                <div style="text-align: center; margin: 15px 0;">
                    <p style="color: #666; font-size: 0.9em; margin-bottom: 10px;">
                        Click on legend items or use buttons below to show/hide metrics
                    </p>
                    <div class="metric-controls">
                        <button onclick="toggleTrace('Temperature')" class="control-btn temp-btn">🌡️ Temperature</button>
                        <button onclick="toggleTrace('CPU Load')" class="control-btn load-btn">📊 CPU Load</button>
                        <button onclick="toggleTrace('CPU Frequency')" class="control-btn freq-btn">⚡ CPU Frequency</button>
                        <span style="margin: 0 15px;">|</span>
                        <button onclick="showAll()" class="control-btn">Show All</button>
                        <button onclick="hideAll()" class="control-btn">Hide All</button>
                    </div>
                </div>
                <div class="chart-container">
                    <div id="temperatureChart"></div>
                </div>
            </div>
            
            <!-- GPU Test Section -->
            <div class="test-section">
                <h2 class="test-title">🎮 GPU Performance</h2>
                {'<div style="padding: 20px; background: #e8f5e9; border-radius: 10px; text-align: center; color: #2e7d32;"><strong>✓ GPU Stress Test Executed Successfully</strong><br>GPU stress test with glmark2 completed</div>' if gpu_stress_status == 'success' else '<div style="padding: 20px; background: #ffebee; border-radius: 10px; text-align: center; color: #c62828;"><strong>✗ GPU Stress Test Failed</strong><br>The GPU stress test encountered an error during execution</div>' if gpu_stress_status == 'failed' else '<div class="placeholder">GPU stress test was not run</div>'}
                {gpu_graph_html if gpu_graph_html else ''}
                {f'<div style="margin-top: 20px;"><h3>GPU Information:</h3><pre style="background: #f5f5f5; padding: 15px; border-radius: 5px; overflow-x: auto; font-size: 12px; line-height: 1.4; color: #333;">{gpu_info_content}</pre></div>' if gpu_info_content else ''}
            </div>
            
            <!-- Power Test Section -->
            <div class="test-section">
                <h2 class="test-title">⚡ Power Consumption</h2>
                <div class="placeholder">
                    Power consumption test not yet implemented
                </div>
            </div>
            
            <!-- CPU Test Section -->
            <div class="test-section">
                <h2 class="test-title">💻 CPU Stress</h2>
                {'<div style="padding: 20px; background: #e8f5e9; border-radius: 10px; text-align: center; color: #2e7d32;"><strong>✓ CPU Stress Test Executed Successfully</strong><br>All CPU cores were loaded for the full test duration</div>' if cpu_stress_status == 'success' else '<div style="padding: 20px; background: #ffebee; border-radius: 10px; text-align: center; color: #c62828;"><strong>✗ CPU Stress Test Failed</strong><br>The stress test encountered an error during execution</div>' if cpu_stress_status == 'failed' else '<div class="placeholder">CPU stress test was not run</div>'}
                {f'<div style="margin-top: 20px;"><h3>Stress Test Log:</h3><pre style="background: #f5f5f5; padding: 15px; border-radius: 5px; overflow-x: auto; font-size: 12px; line-height: 1.4; color: #333;">{cpu_stress_log_content}</pre></div>' if cpu_stress_log_content else ''}
            </div>
            
            <!-- Network Test Section -->
            <div class="test-section">
                <h2 class="test-title">🌐 Network Performance</h2>
                <div class="placeholder">
                    Network performance test not yet implemented
                </div>
            </div>
            
            <!-- Disk Test Section -->
            <div class="test-section">
                <h2 class="test-title">💾 Disk I/O Performance</h2>
                <div class="placeholder">
                    Disk I/O test not yet implemented
                </div>
            </div>
        </div>
        
        <!-- System Info Debug Section -->
        <div style="margin: 20px; padding: 20px; background: white; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <h3 style="font-weight: bold; color: #666; padding: 10px; background: #f8f9fa; border-radius: 5px; margin: 0 0 15px 0;">📋 System Information (Debug)</h3>
            <pre style="padding: 15px; background: #f5f5f5; border-radius: 5px; overflow-x: auto; font-size: 12px; line-height: 1.4; color: #333; margin: 0;">{system_info_text}</pre>
        </div>
        
        <div class="footer">
            Generated on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | RK3576 Board Test Suite
        </div>
    </div>
    
    <script>
        var figure = {fig.to_json()};
        var plotDiv = document.getElementById('temperatureChart');
        
        if (figure.data && figure.data.length > 0) {{
            Plotly.newPlot('temperatureChart', figure.data, figure.layout, {{responsive: true}});
            
            // Initialize button states
            updateButtonStates();
            
            // Add event listener for legend clicks
            plotDiv.on('plotly_legendclick', function() {{
                setTimeout(updateButtonStates, 100);
            }});
        }} else {{
            plotDiv.innerHTML = '<div class="placeholder">No temperature data available</div>';
        }}
        
        // Function to toggle individual traces
        function toggleTrace(metricName) {{
            var data = plotDiv.data;
            var traceIndex = -1;
            
            // Find the trace by partial name match
            for (var i = 0; i < data.length; i++) {{
                if (data[i].name.includes(metricName)) {{
                    traceIndex = i;
                    break;
                }}
            }}
            
            if (traceIndex >= 0) {{
                var visibility = data[traceIndex].visible;
                var update = {{'visible': []}};
                
                for (var i = 0; i < data.length; i++) {{
                    if (i === traceIndex) {{
                        update.visible[i] = (visibility === 'legendonly') ? true : 'legendonly';
                    }} else {{
                        update.visible[i] = data[i].visible;
                    }}
                }}
                
                Plotly.restyle('temperatureChart', update);
                updateButtonStates();
            }}
        }}
        
        // Function to show all traces
        function showAll() {{
            var update = {{'visible': true}};
            Plotly.restyle('temperatureChart', update);
            updateButtonStates();
        }}
        
        // Function to hide all traces
        function hideAll() {{
            var update = {{'visible': 'legendonly'}};
            Plotly.restyle('temperatureChart', update);
            updateButtonStates();
        }}
        
        // Function to update button states based on trace visibility
        function updateButtonStates() {{
            var data = plotDiv.data;
            
            // Update Temperature button
            updateButton('Temperature', '.temp-btn');
            
            // Update CPU Load button
            updateButton('CPU Load', '.load-btn');
            
            // Update CPU Frequency button
            updateButton('CPU Frequency', '.freq-btn');
            
            
            function updateButton(metricName, selector) {{
                var btn = document.querySelector(selector);
                if (!btn) return;
                
                var trace = data.find(function(t) {{ return t.name.includes(metricName); }});
                if (trace) {{
                    if (trace.visible === true || trace.visible === undefined) {{
                        btn.classList.add('active');
                    }} else {{
                        btn.classList.remove('active');
                    }}
                }}
            }}
        }}
    </script>
</body>
</html>
"""
    
    # Write HTML file
    output_file = os.path.join(results_dir, 'report.html')
    with open(output_file, 'w') as f:
        f.write(html_content)
    
    # Silent - no output
    return True

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python generate_combined_report.py <results_dir>")
        sys.exit(1)
    
    results_dir = sys.argv[1]
    
    if not os.path.exists(results_dir):
        print(f"Error: Results directory '{results_dir}' not found")
        sys.exit(1)
    
    success = generate_combined_report(results_dir)
    sys.exit(0 if success else 1)